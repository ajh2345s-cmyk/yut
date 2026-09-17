'use strict';
const { randomInt } = require('node:crypto');
const LABELS = ['', '도', '개', '걸', '윷', '모'];
// Outer ring 1..20. Diagonal A: 5→a1→a2→c→a4→a5→15.
// Diagonal B: 10→b1→b2→c→b4→b5→20. Landing on c may take B exit.
function destination(pos, steps, shortcut = true) {
  if (pos === 'home') throw Error('이미 도착한 말이에요.');
  let p = pos;
  for (let i=0;i<steps;i++) {
    if (p === 'home') break;
    if (p === 'start') p=1;
    else if (i===0 && shortcut && p===5) p='a1';
    else if (i===0 && shortcut && p===10) p='b1';
    else if (p==='a1') p='a2';
    else if (p==='a2') p='ca';
    else if (p==='b1') p='b2';
    else if (p==='b2') p='cb';
    else if (p==='ca') p=(i===0 && shortcut)?'b4':'a4';
    else if (p==='cb') p='b4';
    else if (p==='a4') p='a5';
    else if (p==='a5') p=15;
    else if (p==='b4') p='b5';
    else if (p==='b5') p=20;
    else if (p===20) p='home';
    else p++;
  }
  return p;
}
const cell=p=>p==='ca'||p==='cb'?'c':p;
function newGame(players) { return {players, pieces:[['start','start'],['start','start']], turn:randomInt(2), phase:'throw', pending:[], credits:1, serial:0, last:null, winner:null, revision:0, log:[]}; }
function log(g,t){g.log.unshift(t);g.log=g.log.slice(0,16);}
function roll(g,rand=randomInt){
  if(g.winner!==null||g.phase!=='throw'||g.credits<1)throw Error('지금은 윷을 던질 수 없어요.');
  const sticks=Array.from({length:4},()=>rand(2));
  const sum=sticks.reduce((a,b)=>a+b,0),steps=sum===0?5:sum;
  g.last={sticks,steps,label:LABELS[steps]};g.pending.push({id:++g.serial,steps,label:LABELS[steps]});
  g.credits--;if(steps>=4)g.credits++;
  g.phase=g.credits>0?'throw':'move';g.revision++;
  log(g,`${g.turn===0?'주황':'파랑'} · ${LABELS[steps]}${steps>=4?'! 한 번 더':''}`);
}
function options(g){
  if(g.phase!=='move'||g.winner!==null)return [];
  const out=[];
  g.pieces[g.turn].forEach((pos,piece)=>{
    if(pos==='home')return;
    for(const result of g.pending){const seen=new Set();for(const shortcut of[true,false]){
      const dest=destination(pos,result.steps,shortcut);if(seen.has(dest))continue;seen.add(dest);
      const capture=g.pieces[1-g.turn].filter(p=>p!=='start'&&p!=='home'&&cell(p)===cell(dest)).length;
      const other=g.pieces[g.turn][1-piece];const wins=dest==='home'&&(other==='home'||pos!=='start'&&cell(other)===cell(pos));
      out.push({piece,resultId:result.id,steps:result.steps,label:result.label,shortcut,dest,capture,wins});
    }}
  });return out;
}
function move(g,index,resultId,shortcut=true){
  if(!Number.isInteger(index)||typeof shortcut!=='boolean')throw Error('말과 도착 칸을 골라 주세요.');
  const option=options(g).find(o=>o.piece===index&&o.resultId===resultId&&o.shortcut===shortcut);
  if(!option)throw Error('선택할 수 없는 이동이에요.');
  const own=g.pieces[g.turn],enemy=g.pieces[1-g.turn],old=own[index],target=option.dest;
  const together=old!=='start'&&cell(own[1-index])===cell(old);
  own[index]=target;if(together)own[1-index]=target;
  let captures=0;
  if(target!=='home')enemy.forEach((p,i)=>{if(p!=='start'&&p!=='home'&&cell(p)===cell(target)){enemy[i]='start';captures++;}});
  g.pending=g.pending.filter(r=>r.id!==resultId);if(captures)g.credits++;
  log(g,captures?`${captures}개 잡기!` : target==='home'?'도착!':`${option.label} · ${option.steps}칸 이동`);
  if(own.every(p=>p==='home')){g.winner=g.players[g.turn];g.phase='finished';log(g,'두 말 도착 · 승리!');}
  else if(g.credits>0)g.phase='throw';
  else if(g.pending.length)g.phase='move';
  else{g.turn=1-g.turn;g.phase='throw';g.credits=1;}
  g.revision++;
}
function finishMove(g,piece){
  const choice=options(g).filter(o=>o.piece===piece&&o.wins).sort((a,b)=>a.steps-b.steps||a.resultId-b.resultId)[0];
  if(!choice)throw Error('마지막 말을 완주시키는 이동만 자동 선택할 수 있어요.');
  move(g,choice.piece,choice.resultId,choice.shortcut);
}
function auto(g){if(g.phase==='throw')roll(g);else{const choices=options(g).sort((a,b)=>(b.dest==='home')-(a.dest==='home')||b.capture-a.capture||b.steps-a.steps);const o=choices[0];if(o)move(g,o.piece,o.resultId,o.shortcut);}log(g,'시간 종료 · 자동 진행');}
function shuffle(list,rand=randomInt){const a=[...list];for(let i=a.length-1;i>0;i--){const j=rand(i+1);[a[i],a[j]]=[a[j],a[i]];}return a;}
function bracket(ids,rand=randomInt){
  if(ids.length<2||ids.length>64||new Set(ids).size!==ids.length)throw Error('참가자는 2~64명이어야 해요.');
  let size=2;while(size<ids.length)size*=2;
  const bag=shuffle(ids,rand), byes=size-ids.length, rounds=[];let counter=0;
  // Spread played matches across bracket sections instead of clustering byes.
  const matchCount=size/2, bits=Math.log2(matchCount);
  const reverseBits=n=>{let result=0;for(let b=0;b<bits;b++){result=result*2+(n&1);n>>=1;}return result;};
  const playedSlots=new Set(Array.from({length:matchCount-byes},(_,i)=>reverseBits(i)));
  const first=[];
  for(let i=0;i<size/2;i++) { const players=playedSlots.has(i)?[bag.pop(),bag.pop()]:[bag.pop(),null];first.push({id:`m${++counter}`,players,status:players[1]===null?'bye':'pending',winner:players[1]===null?players[0]:null,game:null}); }
  rounds.push(first);
  for(let n=size/4;n>=1;n/=2)rounds.push(Array.from({length:n},()=>({id:`m${++counter}`,players:[null,null],status:'pending',winner:null,game:null})));
  return rounds;
}
module.exports={destination,cell,newGame,roll,move,bracket,options,auto,finishMove};
