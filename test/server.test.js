const {test}=require('node:test');const assert=require('node:assert/strict');const {io}=require('socket.io-client');const {createApp}=require('../server');
async function setup(t){const app=createApp();await new Promise(r=>app.server.listen(0,'127.0.0.1',r));const clients=[];t.after(async()=>{clients.forEach(s=>s.disconnect());await new Promise(r=>app.io.close(r));});async function connect(){const s=io('http://127.0.0.1:'+app.server.address().port,{transports:['websocket'],forceNew:true});clients.push(s);await new Promise(r=>s.on('connect',r));return s;}return {...app,connect};}
const send=(s,e,d)=>new Promise((resolve,reject)=>s.timeout(2000).emit(e,d,(err,r)=>err?reject(err):resolve(r)));
const tick=()=>new Promise(r=>setTimeout(r,25));
test('메인 화면·정적 파일·상태 점검 경로',async t=>{const a=await setup(t),url='http://127.0.0.1:'+a.server.address().port;for(const path of['/','/client.js','/style.css','/socket.io/socket.io.js','/health']){const response=await fetch(url+path);assert.equal(response.status,200);if(!path.startsWith('/socket.io/'))assert.equal(response.headers.get('x-content-type-options'),'nosniff');await response.text();}assert.deepEqual(await(await fetch(url+'/health')).json(),{ok:true});assert.equal((await fetch(url+'/server.js')).status,404);});
test('권한, 관전, 동시 요청, 일시정지, 연결 복구, 최종 우승',async t=>{
 const a=await setup(t),teacher=await a.connect();assert.equal((await send(teacher,'enter',{role:'teacher',password:'wrong'})).ok,false);
 const host=await send(teacher,'enter',{role:'teacher',password:'gmltn'});assert.ok(host.ok);const code=host.code;
 const students=[];for(let i=0;i<3;i++){const s=await a.connect(),id=await send(s,'enter',{code,name:'학생'+i});students.push({s,...id});}
 const room=a.rooms.get(code);assert.equal((await send(students[0].s,'admin',{action:'draw'})).ok,false);
 assert.ok((await send(teacher,'admin',{action:'draw'})).ok);assert.equal(room.rounds[0].filter(m=>m.status==='bye').length,1);
 const spectator=await a.connect(),sp=await send(spectator,'enter',{code,name:'새관전자'});assert.ok(sp.ok);
 let publicState;spectator.on('state',s=>publicState=s);
 assert.ok((await send(teacher,'admin',{action:'start'})).ok);await tick();assert.ok(publicState);assert.ok(publicState.players.every(p=>!('online'in p)));assert.ok(!JSON.stringify(publicState).includes('gmltn'));
 const m=room.rounds[0].find(m=>m.status==='playing'),active=students.find(s=>s.playerId===m.game.players[m.game.turn]);
 const play={matchId:m.id,revision:0,action:'throw'};
 assert.equal((await send(spectator,'play',play)).ok,false);
 assert.ok((await send(teacher,'admin',{action:'pause'})).ok);assert.equal((await send(active.s,'play',play)).ok,false);await send(teacher,'admin',{action:'pause'});
 const results=await Promise.all([send(active.s,'play',play),send(active.s,'play',play)]);assert.equal(results.filter(x=>x.ok).length,1);
 teacher.disconnect();await tick();assert.equal((await send(active.s,'play',{...play,action:'move',piece:0,shortcut:true,revision:m.game.revision})).ok,false);
 const teacher2=await a.connect();assert.ok((await send(teacher2,'resume',{token:host.token})).ok);
 active.s.disconnect();await tick();const active2=await a.connect();assert.ok((await send(active2,'resume',{token:active.token})).ok);
 active2.disconnect();await tick();assert.ok((await send(teacher2,'admin',{action:'reconnect',target:active.playerId,fresh:sp.playerId})).ok);assert.equal(spectator.connected,true);assert.equal(room.players[active.playerId].socket,spectator.id);
 assert.ok((await send(teacher2,'admin',{action:'decide',matchId:m.id,winner:m.players[0]})).ok);assert.equal(room.phase,'between');assert.ok((await send(teacher2,'admin',{action:'start'})).ok);const final=room.rounds[1][0];assert.ok(final.players.every(Boolean));
 assert.ok((await send(teacher2,'admin',{action:'decide',matchId:final.id,winner:final.players[1]})).ok);assert.equal(room.phase,'finished');assert.equal(room.champion,final.players[1]);
 assert.ok((await send(teacher2,'admin',{action:'reset'})).ok);assert.equal(room.rounds.length,0);assert.equal(room.phase,'lobby');
});
test('19명·20명 실시간 토너먼트 전 라운드 완료',async t=>{for(const n of[19,20]){const a=await setup(t),teacher=await a.connect(),host=await send(teacher,'enter',{role:'teacher',password:'gmltn'});for(let i=0;i<n;i++){const s=await a.connect();assert.ok((await send(s,'enter',{code:host.code,name:'학생'+i})).ok);}const room=a.rooms.get(host.code);assert.ok((await send(teacher,'admin',{action:'draw'})).ok);let wins=0;while(room.phase!=='finished'){assert.ok((await send(teacher,'admin',{action:'start'})).ok);for(const m of room.rounds[room.round])if(m.status==='playing'){assert.ok((await send(teacher,'admin',{action:'decide',matchId:m.id,winner:m.players[0]})).ok);wins++;await new Promise(r=>setTimeout(r,60));}}assert.equal(wins,n-1);assert.ok(room.champion);}});
