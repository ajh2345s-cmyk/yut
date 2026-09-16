'use strict';
const express=require('express');
const http=require('node:http');
const crypto=require('node:crypto');
const path=require('node:path');
const {Server}=require('socket.io');
const G=require('./game');
function createApp({adminCode=process.env.ADMIN_CODE||'gmltn'}={}) {
 const app=express(), server=http.createServer(app), io=new Server(server,{maxHttpBufferSize:16000});
 app.disable('x-powered-by');
 app.use((req,res,next)=>{res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','same-origin');res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data:; frame-ancestors 'none'");next();});
 app.get('/health',(_,res)=>res.json({ok:true}));app.use(express.static(path.join(__dirname,'public')));
 const rooms=new Map(),sessions=new Map(),attempts=new Map();
 function snapshot(room,teacher=false){return {code:room.code,phase:room.phase,paused:room.paused,round:room.round,champion:room.champion,teacherOnline:!!room.teacherSocket,players:Object.values(room.players).map(p=>({id:p.id,name:p.name,eligible:p.eligible,...(teacher?{online:!!p.socket}:{})})),rounds:room.rounds};}
 function push(room){for(const s of io.sockets.sockets.values()) if(s.data.room===room.code)s.emit('state',snapshot(room,s.data.role==='teacher'));}
 function finish(room,m,winner,reason){m.winner=winner;m.status='finished';m.reason=reason;if(m.game){m.game.winner=winner;m.game.phase='finished';m.game.revision++;} if(room.rounds[room.round].every(x=>x.winner!==null)){room.phase=room.round===room.rounds.length-1?'finished':'between';if(room.phase==='finished')room.champion=winner;}}
 function establish(socket,room,role,playerId){const token=crypto.randomBytes(32).toString('hex');sessions.set(token,{room:room.code,role,playerId});socket.data={room:room.code,role,playerId,token};if(role==='teacher')room.teacherSocket=socket.id;else room.players[playerId].socket=socket.id;return {token,role,playerId,code:room.code};}
 function verifyCode(value){const a=Buffer.from(String(value||'')),b=Buffer.from(adminCode);return a.length===b.length&&crypto.timingSafeEqual(a,b);}
 io.on('connection',socket=>{
  let windowStart=Date.now(),count=0;
  const on=(event,fn)=>socket.on(event,(data,ack)=>{if(typeof ack!=='function')return;try{if(Date.now()-windowStart>1000){windowStart=Date.now();count=0;}if(++count>25)throw Error('잠시 후 다시 눌러 주세요.');const result=fn(data&&typeof data==='object'?data:{});ack({ok:true,...result});}catch(e){ack({ok:false,error:e.message});}});
  on('enter',d=>{
   if(socket.data.room)throw Error('이미 입장했어요.');
   let room,role,playerId=null;
   if(d.role==='teacher'){
    const ip=socket.handshake.address;let a=attempts.get(ip);if(!a||Date.now()-a.time>60000){a={time:Date.now(),n:0};attempts.set(ip,a);}if(++a.n>10)throw Error('1분 후 다시 시도해 주세요.');
    if(!verifyCode(d.password))throw Error('선생님 코드가 맞지 않아요.');role='teacher';
    if(d.code){room=rooms.get(String(d.code));if(!room)throw Error('교실 번호를 확인해 주세요.');if(room.teacherSocket)throw Error('이미 선생님이 접속해 있어요.');}
    else {if(rooms.size>=100)throw Error('사용 중인 교실이 많아요.');let code;do{code=String(crypto.randomInt(100000,1000000));}while(rooms.has(code));room={code,teacherSocket:null,players:{},rounds:[],round:-1,phase:'lobby',paused:false,champion:null,touched:Date.now()};rooms.set(code,room);}
   }else {role='student';room=rooms.get(String(d.code));if(!room)throw Error('교실 번호를 확인해 주세요.');const name=typeof d.name==='string'?d.name.trim().normalize('NFC'):'';if(!name||name.length>12||/[\x00-\x1f<>]/.test(name))throw Error('이름은 1~12자로 입력해 주세요.');if(Object.values(room.players).some(p=>p.name===name))throw Error('같은 이름이 있어요. 번호도 붙여 주세요.');if(Object.keys(room.players).length>=100)throw Error('교실이 가득 찼어요.');playerId=crypto.randomUUID();room.players[playerId]={id:playerId,name,socket:socket.id,eligible:room.phase==='lobby'};}
   const result=establish(socket,room,role,playerId);room.touched=Date.now();setImmediate(()=>push(room));return result;
  });
  on('resume',d=>{if(socket.data.room)throw Error('이미 입장했어요.');const s=sessions.get(d.token),room=s&&rooms.get(s.room);if(!room)throw Error('접속이 만료됐어요. 다시 입장해 주세요.');const old=s.role==='teacher'?room.teacherSocket:room.players[s.playerId]?.socket;if(old&&old!==socket.id)throw Error('이미 다른 연결에서 사용 중이에요.');socket.data={...s,token:d.token};if(s.role==='teacher')room.teacherSocket=socket.id;else if(room.players[s.playerId])room.players[s.playerId].socket=socket.id;else throw Error('참가 정보가 없어요.');room.touched=Date.now();setImmediate(()=>push(room));return {role:s.role,playerId:s.playerId,code:room.code};});
  on('admin',d=>{
   const room=rooms.get(socket.data.room);if(!room||socket.data.role!=='teacher'||room.teacherSocket!==socket.id)throw Error('선생님만 사용할 수 있어요.');
   if(d.action==='draw'){if(room.phase!=='lobby')throw Error('이미 대진표가 있어요.');const ids=Object.values(room.players).filter(p=>p.eligible&&p.socket).map(p=>p.id);room.rounds=G.bracket(ids);room.round=0;room.phase='ready';}
   else if(d.action==='start'){if(!['ready','between'].includes(room.phase))throw Error('라운드를 시작할 수 없어요.');if(room.phase==='between'){const prev=room.rounds[room.round++];room.rounds[room.round].forEach((m,i)=>m.players=[prev[2*i].winner,prev[2*i+1].winner]);}for(const m of room.rounds[room.round])if(m.status==='pending'){m.game=G.newGame(m.players);m.status='playing';}room.phase='playing';room.paused=false;}
   else if(d.action==='pause'){if(room.phase!=='playing')throw Error('경기 중에만 사용할 수 있어요.');room.paused=!room.paused;}
   else if(d.action==='decide'){const m=room.rounds[room.round]?.find(x=>x.id===d.matchId);if(!m||m.status!=='playing'||!m.players.includes(d.winner))throw Error('진행 중인 경기와 승자를 선택해 주세요.');finish(room,m,d.winner,'선생님 판정');}
   else if(d.action==='remove'){if(room.phase!=='lobby')throw Error('대진 확정 전만 제외할 수 있어요.');const p=room.players[d.playerId];if(!p)throw Error('학생이 없어요.');p.eligible=!p.eligible;}
   else if(d.action==='reconnect'){const target=room.players[d.target],fresh=room.players[d.fresh];if(!target||target.socket||!fresh?.socket||fresh.eligible||room.rounds.flat().some(m=>m.players.includes(fresh.id)))throw Error('끊긴 참가자와 새 관전 학생을 선택해 주세요.');const s=io.sockets.sockets.get(fresh.socket);for(const [key,v]of sessions)if(v.playerId===target.id||v.playerId===fresh.id)sessions.delete(key);delete room.players[fresh.id];const identity=establish(s,room,'student',target.id);s.emit('identity',identity);}
   else if(d.action==='reset'){room.rounds=[];room.round=-1;room.phase='lobby';room.paused=false;room.champion=null;for(const p of Object.values(room.players)){if(!p.socket){delete room.players[p.id];for(const [key,v]of sessions)if(v.playerId===p.id)sessions.delete(key);}else p.eligible=true;}}
   else throw Error('알 수 없는 요청이에요.');room.touched=Date.now();push(room);return {};
  });
  on('play',d=>{const room=rooms.get(socket.data.room);if(!room||socket.data.role!=='student'||room.phase!=='playing'||room.paused||!room.teacherSocket)throw Error('선생님의 진행을 기다려 주세요.');const m=room.rounds[room.round]?.find(x=>x.id===d.matchId),id=socket.data.playerId;if(!m||m.status!=='playing'||!m.players.includes(id))throw Error('내 경기에서만 조작할 수 있어요.');if(!m.players.every(p=>room.players[p]?.socket))throw Error('상대방 연결을 기다려 주세요.');const g=m.game;if(g.players[g.turn]!==id)throw Error('상대방 차례예요.');if(d.revision!==g.revision)throw Error('화면이 갱신됐어요. 다시 눌러 주세요.');if(d.action==='throw')G.roll(g);else if(d.action==='move')G.move(g,d.piece,d.shortcut);else throw Error('잘못된 요청이에요.');if(g.winner!==null)finish(room,m,g.winner,'두 말 도착');room.touched=Date.now();push(room);return {};});
  socket.on('disconnect',()=>{const room=rooms.get(socket.data.room);if(!room)return;if(socket.data.role==='teacher'&&room.teacherSocket===socket.id)room.teacherSocket=null;else{const p=room.players[socket.data.playerId];if(p?.socket===socket.id)p.socket=null;}room.touched=Date.now();push(room);});
 });
 const timer=setInterval(()=>{for(const [code,r]of rooms)if(!r.teacherSocket&&!Object.values(r.players).some(p=>p.socket)&&Date.now()-r.touched>6*3600000){rooms.delete(code);for(const [k,s]of sessions)if(s.room===code)sessions.delete(k);}for(const [k,a]of attempts)if(Date.now()-a.time>60000)attempts.delete(k);},60000);timer.unref();
 server.on('close',()=>clearInterval(timer));return {app,server,io,rooms};
}
if(require.main===module){const {server}=createApp();server.listen(Number(process.env.PORT)||3000,'0.0.0.0',()=>console.log('교실 윷놀이 서버 시작'));}
module.exports={createApp};
