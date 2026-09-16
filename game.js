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
function newGame(players) { return {players, pieces:[['start','start'],['start','start']], turn:randomInt(2), phase:'throw', result:null, last:null, winner:null, revision:0, log:['두 말을 모두 도착시키면 승리!']}; }
function roll(game, rand=randomInt) {
  if(game.winner!==null || game.phase!=='throw') throw Error('지금은 윷을 던질 수 없어요.');
  const sticks=Array.from({length:4},()=>rand(2));
  const sum=sticks.reduce((a,b)=>a+b,0), steps=sum===0?5:sum;
  game.result=steps; game.last={sticks,steps,label:LABELS[steps]}; game.phase='move'; game.revision++;
  game.log.unshift(`${game.turn===0?'주황':'파랑'} · ${LABELS[steps]}! ${steps}칸 이동하세요.`); game.log=game.log.slice(0,12);
}
function move(game,index,shortcut=true) {
  if(game.winner!==null || game.phase!=='move' || !Number.isInteger(index) || index<0 || index>1 || typeof shortcut!=='boolean') throw Error('이동할 말을 골라 주세요.');
  const side=game.turn, own=game.pieces[side], enemy=game.pieces[1-side], old=own[index];
  if(old==='home') throw Error('이미 도착한 말이에요.');
  const target=destination(old,game.result,shortcut);
  const together=old!=='start' && cell(own[1-index])===cell(old);
  own[index]=target; if(together) own[1-index]=target;
  let captures=0;
  if(target!=='home') enemy.forEach((p,i)=>{ if(p!=='start'&&p!=='home'&&cell(p)===cell(target)){enemy[i]='start';captures++;} });
  const extra=game.result>=4||captures>0;
  if(own.every(p=>p==='home')) {game.winner=game.players[side];game.phase='finished';game.log.unshift('두 말 모두 도착! 승리했어요.');}
  else {game.phase='throw';if(!extra)game.turn=1-side;game.log.unshift(captures?`${captures}개 잡기! 한 번 더 던져요.`:extra?'윷·모! 한 번 더 던져요.':target==='home'?'말이 도착했어요!':'다음 차례예요.');}
  game.result=null;game.revision++;game.log=game.log.slice(0,12);
}
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
module.exports={destination,cell,newGame,roll,move,bracket};
