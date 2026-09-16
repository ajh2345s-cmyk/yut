'use strict';
const express=require('express'),http=require('node:http'),crypto=require('node:crypto'),path=require('node:path'),fs=require('node:fs');
const {Server}=require('socket.io'),QRCode=require('qrcode'),G=require('./game');
function createApp({adminCode=process.env.ADMIN_CODE||'gmltn',dataFile=process.env.DATA_FILE||path.join(__dirname,'data','state.json'),now=Date.now,tickMs=250}={}){
 const app=express(),server=http.createServer(app),io=new Server(server,{maxHttpBufferSize:16000,pingInterval:5000,pingTimeout:10000});
 const rooms=new Map(),sessions=new Map(),attempts=new Map();let storageError=false,closing=false,lastCheckpoint=now();
 if(dataFile){let loaded=false;for(const file of[dataFile,dataFile+'.bak']){if(!fs.existsSync(file))continue;try{const data=JSON.parse(fs.readFileSync(file,'utf8'));if(data.version!==2)throw Error('저장 버전이 다릅니다.');for(const r of data.rooms){r.teacherSocket=null;for(const p of Object.values(r.players)){p.socket=null;p.active=false;}for(const m of r.rounds.flat())if(m.clock){m.clock.remaining=m.clock.deadline?Math.max(0,m.clock.deadline-data.savedAt):m.clock.remaining;m.clock.deadline=null;}rooms.set(r.code,r);}for(const [k,v]of data.sessions)sessions.set(k,v);loaded=true;break;}catch(e){console.error('저장 파일 읽기 실패:',file,e.message);}}if(!loaded&&(fs.existsSync(dataFile)||fs.existsSync(dataFile+'.bak')))throw Error('저장 파일 복구가 필요합니다. 원본 데이터를 확인하세요.');}
 function save(){if(!dataFile)return;try{fs.mkdirSync(path.dirname(dataFile),{recursive:true});const data=JSON.stringify({version:2,savedAt:now(),rooms:[...rooms.values()],sessions:[...sessions]});const temp=dataFile+'.tmp';fs.writeFileSync(temp,data,{mode:0o600});if(fs.existsSync(dataFile))fs.copyFileSync(dataFile,dataFile+'.bak');fs.renameSync(temp,dataFile);storageError=false;}catch(e){storageError=true;for(const r of rooms.values())r.paused=true;console.error('경기 저장 실패:',e.message);throw Error('저장 공간을 확인해 주세요. 경기를 일시정지했습니다.');}}
 function block(r,m){if(storageError)return '저장 오류';if(r.paused)return '선생님 일시정지';if(!r.teacherSocket)return '선생님 재접속 대기';if(m.players.some(id=>!r.players[id]?.socket||!r.players[id]?.active))return '참가자 재접속 대기';return '';}
 function resetClock(r,m){m.clock={remaining:r.settings[m.game.phase==='throw'?'throwSeconds':'moveSeconds']*1000,deadline:null};syncClock(r,m);}
 function syncClock(r,m){if(!m.clock||m.status!=='playing')return;const c=m.clock,blocked=block(r,m);if(blocked){if(c.deadline!==null)c.remaining=Math.max(0,c.deadline-now());c.deadline=null;}else if(c.deadline===null&&r.settings[m.game.phase==='throw'?'throwSeconds':'moveSeconds']>0)c.deadline=now()+c.remaining;}
 function synchronize(r){for(const m of r.rounds.flat())syncClock(r,m);}
 function view(r,teacher){return {code:r.code,phase:r.phase,round:r.round,paused:r.paused,champion:r.champion,teacherOnline:!!r.teacherSocket,settings:r.settings,serverNow:now(),storageError,players:Object.values(r.players).map(p=>({id:p.id,name:p.name,eligible:p.eligible,...(teacher?{online:!!p.socket,active:p.active}:{})})),rounds:r.rounds.map(round=>round.map(m=>({...m,blocked:m.status==='playing'?block(r,m):'',game:m.game?{...m.game,moves:G.options(m.game)}:null,...(teacher?{spectators:[...io.sockets.sockets.values()].filter(s=>s.data.room===r.code&&s.data.view===m.id&&s.data.role==='student'&&!(m.status==='playing'&&m.players.includes(s.data.playerId))).map(s=>({id:s.data.playerId,name:r.players[s.data.playerId]?.name||''}))}:{})})))};}
 function push(r,persist=true){r.touched=now();synchronize(r);if(persist)save();for(const s of io.sockets.sockets.values())if(s.data.room===r.code)s.emit('state',view(r,s.data.role==='teacher'));}
 function attach(s,r,role,playerId,token){const old=role==='teacher'?r.teacherSocket:r.players[playerId]?.socket;if(role==='student'&&!r.players[playerId])throw Error('이 참가 자리는 종료됐어요.');s.data={room:r.code,role,playerId,token,view:null};if(role==='teacher')r.teacherSocket=s.id;else {r.players[playerId].socket=s.id;r.players[playerId].active=true;}if(old&&old!==s.id){const previous=io.sockets.sockets.get(old);if(previous){previous.emit('replaced');previous.disconnect(true);}}const own=r.rounds[r.round]?.find(m=>m.players.includes(playerId));s.data.view=own?.id||null;return {token,role,playerId,code:r.code};}
 function establish(s,r,role,playerId){const token=crypto.randomBytes(32).toString('hex');sessions.set(token,{room:r.code,role,playerId});return attach(s,r,role,playerId,token);}
 function finish(r,m,winner,reason){m.winner=winner;m.status='finished';m.reason=reason;m.clock=null;if(m.game){m.game.winner=winner;m.game.phase='finished';m.game.revision++;}if(r.rounds[r.round].every(x=>x.winner!==null)){r.phase=r.round===r.rounds.length-1?'finished':'between';if(r.phase==='finished')r.champion=winner;}}
 function applyPlay(r,m,d){if(d.action==='throw')G.roll(m.game);else if(d.action==='move')G.move(m.game,d.piece,d.resultId,d.shortcut);else throw Error('잘못된 요청이에요.');if(m.game.winner!==null)finish(r,m,m.game.winner,'두 말 도착');else resetClock(r,m);}
 function verify(value){const a=Buffer.from(String(value||'')),b=Buffer.from(adminCode);return a.length===b.length&&crypto.timingSafeEqual(a,b);}
 app.disable('x-powered-by');app.use((req,res,next)=>{res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','same-origin');res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data:; frame-ancestors 'none'");next();});
 app.get('/health',(_,res)=>res.status(storageError?503:200).json({ok:!storageError}));app.use(express.static(path.join(__dirname,'public')));
 io.on('connection',socket=>{
  let windowStart=now(),count=0;
  function on(event,fn){socket.on(event,async(data,ack)=>{if(typeof ack!=='function')return;try{if(now()-windowStart>1000){windowStart=now();count=0;}if(++count>40)throw Error('잠시 후 다시 눌러 주세요.');const result=await fn(data&&typeof data==='object'?data:{});ack({ok:true,...result});}catch(e){ack({ok:false,error:e.message});}});}
  function teacher(){const r=rooms.get(socket.data.room);if(!r||socket.data.role!=='teacher'||r.teacherSocket!==socket.id)throw Error('선생님만 사용할 수 있어요.');return r;}
  on('enter',d=>{
   if(socket.data.room)throw Error('이미 입장했어요.');let r,role,playerId=null;
   if(d.role==='teacher'){const ip=socket.handshake.address;let a=attempts.get(ip);if(!a||now()-a.time>60000){a={time:now(),n:0};attempts.set(ip,a);}if(++a.n>10)throw Error('1분 후 다시 시도해 주세요.');if(!verify(d.password))throw Error('선생님 코드가 맞지 않아요.');role='teacher';if(d.code){r=rooms.get(String(d.code));if(!r)throw Error('교실 번호를 확인해 주세요.');if(r.teacherSocket)throw Error('이미 선생님이 접속 중이에요.');}else{if(rooms.size>=100)throw Error('교실이 가득 찼어요.');let code;do{code=String(crypto.randomInt(100000,1000000));}while(rooms.has(code));r={code,teacherSocket:null,players:{},rounds:[],round:-1,phase:'lobby',paused:false,champion:null,settings:{throwSeconds:15,moveSeconds:30},touched:now()};rooms.set(code,r);}}
   else{role='student';r=rooms.get(String(d.code));if(!r)throw Error('교실 번호를 확인해 주세요.');const name=typeof d.name==='string'?d.name.trim().normalize('NFC'):'';if(!name||name.length>12||/[\x00-\x1f<>]/.test(name))throw Error('이름은 1~12자로 입력해 주세요.');if(Object.values(r.players).some(p=>p.name===name))throw Error('같은 이름이 있어요. 원래 기기로 접속하거나 선생님에게 복구를 요청하세요.');if(Object.keys(r.players).length>=100)throw Error('교실이 가득 찼어요.');playerId=crypto.randomUUID();r.players[playerId]={id:playerId,name,socket:null,active:true,eligible:r.phase==='lobby'};}
   const result=establish(socket,r,role,playerId);push(r);return result;
  });
  on('resume',d=>{if(socket.data.room)throw Error('이미 입장했어요.');const s=sessions.get(d.token),r=s&&rooms.get(s.room);if(!r)throw Error('저장된 참가 정보가 없어요. 다시 입장해 주세요.');const result=attach(socket,r,s.role,s.playerId,d.token);push(r);return result;});
  on('presence',d=>{const r=rooms.get(socket.data.room);if(!r)return {};const p=r.players[socket.data.playerId];if(p&&p.socket===socket.id&&p.active!==(d.active!==false)){p.active=d.active!==false;push(r);}return {};});
  on('watch',d=>{const r=rooms.get(socket.data.room);if(!r)throw Error('먼저 입장해 주세요.');if(d.matchId!==null&&!r.rounds.flat().some(m=>m.id===d.matchId))throw Error('경기가 없어요.');socket.data.view=d.matchId;push(r,false);return {};});
  on('qr',async d=>{const r=teacher();const base=new URL(process.env.PUBLIC_URL||String(d.origin));if(!['http:','https:'].includes(base.protocol))throw Error('접속 주소를 확인해 주세요.');base.pathname='/';base.search='';base.hash='';base.searchParams.set('room',r.code);return {url:base.href,image:await QRCode.toDataURL(base.href,{width:640,margin:4,errorCorrectionLevel:'M'})};});
  on('admin',d=>{
   const r=teacher();
   if(d.action==='draw'){if(r.phase!=='lobby')throw Error('이미 대진을 확정했어요.');r.rounds=G.bracket(Object.values(r.players).filter(p=>p.eligible&&p.socket).map(p=>p.id));r.round=0;r.phase='ready';}
   else if(d.action==='prepare'){if(r.phase!=='between')throw Error('모든 경기가 끝나야 해요.');const previous=r.rounds[r.round++];r.rounds[r.round].forEach((m,i)=>m.players=[previous[i*2].winner,previous[i*2+1].winner]);r.phase='ready';}
   else if(d.action==='start'){if(r.phase!=='ready')throw Error('대진표를 먼저 공개해 주세요.');for(const m of r.rounds[r.round])if(m.status==='pending'){m.game=G.newGame(m.players);m.status='playing';resetClock(r,m);}r.phase='playing';r.paused=false;for(const s of io.sockets.sockets.values())if(s.data.room===r.code){const m=r.rounds[r.round].find(m=>m.players.includes(s.data.playerId));if(m?.game)s.data.view=m.id;}}
   else if(d.action==='pause'){if(r.phase!=='playing')throw Error('경기 중에만 사용할 수 있어요.');r.paused=!r.paused;}
   else if(d.action==='settings'){for(const key of['throwSeconds','moveSeconds'])if(!Number.isInteger(d[key])||d[key]<0||d[key]>180||(d[key]>0&&d[key]<5))throw Error('시간은 0(무제한) 또는 5~180초로 설정하세요.');r.settings={throwSeconds:d.throwSeconds,moveSeconds:d.moveSeconds};for(const m of r.rounds.flat())if(m.status==='playing')resetClock(r,m);}
   else if(d.action==='decide'){const m=r.rounds[r.round]?.find(m=>m.id===d.matchId);if(!m||m.status!=='playing'||!m.players.includes(d.winner))throw Error('진행 중인 경기의 승자를 골라 주세요.');finish(r,m,d.winner,'선생님 판정');}
   else if(d.action==='remove'){if(r.phase!=='lobby')throw Error('대진 확정 전에만 바꿀 수 있어요.');const p=r.players[d.playerId];if(!p)throw Error('참가자가 없어요.');p.eligible=!p.eligible;}
   else if(d.action==='reconnect'){const target=r.players[d.target],fresh=r.players[d.fresh];if(!target||target.socket||!fresh?.socket||fresh.eligible||r.rounds.flat().some(m=>m.players.includes(fresh.id)))throw Error('끊긴 자리와 새 관전 학생을 선택하세요.');const s=io.sockets.sockets.get(fresh.socket);for(const [key,v]of sessions)if(v.playerId===target.id||v.playerId===fresh.id)sessions.delete(key);delete r.players[fresh.id];s.emit('identity',establish(s,r,'student',target.id));}
   else if(d.action==='reset'){r.rounds=[];r.round=-1;r.phase='lobby';r.paused=false;r.champion=null;for(const p of Object.values(r.players))p.eligible=true;for(const s of io.sockets.sockets.values())if(s.data.room===r.code)s.data.view=null;}
   else throw Error('알 수 없는 요청이에요.');push(r);return {};
  });
  on('play',d=>{const r=rooms.get(socket.data.room),id=socket.data.playerId;if(!r||socket.data.role!=='student'||r.players[id]?.socket!==socket.id||r.phase!=='playing')throw Error('시작을 기다려 주세요.');const m=r.rounds[r.round]?.find(m=>m.id===d.matchId);if(!m||m.status!=='playing'||!m.players.includes(id))throw Error('내 경기만 조작할 수 있어요.');const reason=block(r,m);if(reason)throw Error(reason);if(m.game.players[m.game.turn]!==id)throw Error('상대방 차례예요.');if(d.revision!==m.game.revision)throw Error('화면이 바뀌었어요. 다시 선택해 주세요.');applyPlay(r,m,d);push(r);return {};});
  socket.on('disconnect',()=>{if(closing)return;const r=rooms.get(socket.data.room);if(!r)return;if(r.teacherSocket===socket.id)r.teacherSocket=null;const p=r.players[socket.data.playerId];if(p?.socket===socket.id){p.socket=null;p.active=false;}try{push(r);}catch(e){console.error(e.message);}});
 });
 const confirmations=new Set();
 async function confirmConnected(r,m){
  const answers=await Promise.all(m.players.map(id=>new Promise(resolve=>{
   const p=r.players[id],s=io.sockets.sockets.get(p?.socket);if(!s){resolve(false);return;}
   s.timeout(2000).emit('confirmAuto',{matchId:m.id,revision:m.game.revision},(error,answer)=>{
    const ok=!error&&answer===true;if(!ok&&p.socket===s.id)p.active=false;resolve(ok);
   });
  })));return answers.every(Boolean);
 }
 async function tick(){if(closing)return;const work=[];for(const r of rooms.values())for(const m of r.rounds[r.round]||[]){if(m.status!=='playing')continue;syncClock(r,m);if(!block(r,m)&&m.clock?.deadline!==null&&m.clock.deadline<=now()&&!confirmations.has(m)){
  confirmations.add(m);const revision=m.game.revision,deadline=m.clock.deadline;
  work.push((async()=>{try{const online=await confirmConnected(r,m);if(closing)return;if(online&&!block(r,m)&&m.status==='playing'&&m.game.revision===revision&&m.clock?.deadline===deadline){G.auto(m.game);if(m.game.winner!==null)finish(r,m,m.game.winner,'두 말 도착');else resetClock(r,m);}push(r);}finally{confirmations.delete(m);}})());
 }}await Promise.all(work);if(closing)return;if(now()-lastCheckpoint>5000){save();lastCheckpoint=now();}for(const [key,a]of attempts)if(now()-a.time>60000)attempts.delete(key);}
 const timer=setInterval(()=>{tick().catch(e=>console.error(e.message));},tickMs);timer.unref();
 server.on('close',()=>clearInterval(timer));
 async function close(){closing=true;clearInterval(timer);for(const r of rooms.values()){r.teacherSocket=null;for(const p of Object.values(r.players)){p.socket=null;p.active=false;}synchronize(r);}save();await new Promise(resolve=>io.close(resolve));}
 return {app,server,io,rooms,sessions,tick,save,close};
}
if(require.main===module){const instance=createApp();instance.server.listen(Number(process.env.PORT)||3000,'0.0.0.0',()=>console.log('윷놀이 서버 시작'));for(const sig of['SIGTERM','SIGINT'])process.once(sig,()=>instance.close().then(()=>process.exit(0)));}
module.exports={createApp};
