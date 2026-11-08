import test from 'node:test';
import assert from 'node:assert/strict';
import {NIWA_SKILL,ROSTER,createMatch,step,drainEvents} from './engine.mjs';
function advance(m,seconds,input={},cpu={},events=[]) { for(let i=0;i<Math.ceil(seconds*120);i++){step(m,input,1/120,cpu);events.push(...drainEvents(m));} return events; }
function playing(opponent='daodun') {const m=createMatch('niwa',opponent);advance(m,2.3);m.fighters[0].x=500;m.fighters[1].x=650;return m;}
function cast(m) {step(m,{skill:true},1/120,{});drainEvents(m);return m;}
test('laughter deals exactly 21 separate one-point hits with no 22nd pulse',()=>{
 const m=cast(playing()),events=advance(m,4,{skill:true});const hits=events.filter(e=>e.type==='hit');
 assert.equal(hits.length,21);assert.ok(hits.every(e=>e.damage===1));assert.deepEqual(hits.map(e=>e.pulse),Array.from({length:21},(_,i)=>i+1));assert.equal(m.fighters[1].hp,104);
 assert.equal(events.filter(e=>e.type==='sonic').length,21);assert.equal(m.stats.playerHits,21);assert.equal(m.fighters[0].move,null);
});
test('first pulse has a windup and subsequent damage is frequent rather than a lump sum',()=>{
 const m=cast(playing());advance(m,.2);assert.equal(m.fighters[1].hp,125);advance(m,.1);assert.equal(m.fighters[1].hp,124);advance(m,.1);assert.equal(m.fighters[1].hp,123);
});
test('pulse timing is 0.1 seconds and retains the old stamina and cooldown budget',()=>{
 const m=cast(playing());assert.equal(m.fighters[0].stamina,72);assert.equal(m.fighters[0].skillCooldown,5.5);
 const times=[];for(let i=0;i<320;i++){step(m,{},1/120,{});for(const e of drainEvents(m))if(e.type==='sonic')times.push(m.elapsed);}
 assert.equal(times.length,21);for(let i=1;i<times.length;i++)assert.ok(Math.abs(times[i]-times[i-1]-NIWA_SKILL.interval)<1/120);
});
test('real hitstun holds movement, jump, dash and skills while pulses connect',()=>{
 const m=cast(playing());advance(m,.30);const f=m.fighters[1],x=f.x;
 advance(m,1.5,{}, {right:true,jump:true,dash:true,skill:true});
 assert.equal(f.x,x);assert.equal(f.y,0);assert.equal(f.move,null);assert.ok(f.controlled>0);assert.ok(f.stun>0);assert.equal(f.action,'hurt');
});
test('control expires naturally after the final pulse and never becomes a permanent lock',()=>{
 const m=cast(playing());advance(m,2.55);assert.equal(m.fighters[1].controlled,0);assert.equal(m.fighters[1].stun,0);
 const x=m.fighters[1].x;advance(m,.2,{}, {right:true});assert.ok(m.fighters[1].x>x+25);
});
test('outside the sound radius there is no damage or control, including after the cast',()=>{
 const m=playing();m.fighters[1].x=1000;cast(m);advance(m,3);assert.equal(m.fighters[1].hp,125);assert.equal(m.fighters[1].controlled,0);
 m.fighters[1].x=650;advance(m,1);assert.equal(m.fighters[1].hp,125);
});
test('leaving and reentering the range loses missed damage rather than catching it up',()=>{
 const m=cast(playing());advance(m,.65);assert.equal(m.fighters[1].hp,121);
 m.fighters[1].x=1000;advance(m,1);m.fighters[1].x=650;const events=advance(m,1.5);
 assert.equal(m.fighters[1].hp,114);assert.ok(events.filter(e=>e.type==='hit').every(e=>e.damage===1));
});
test('dodging the first pulse leaves exactly 20 damage and does not transfer the missed point',()=>{
 const m=playing();m.fighters[1].invulnerable=.35;cast(m);advance(m,3);
 assert.equal(m.stats.dodges,1);assert.equal(m.fighters[1].hp,105);assert.equal(m.stats.playerHits,20);
});
test('guarding every pulse retains two total chip damage without unblocked control',()=>{
 const m=playing();step(m,{skill:true},1/120,{guard:true});drainEvents(m);const events=advance(m,3,{}, {guard:true});
 const blocks=events.filter(e=>e.type==='block');assert.equal(blocks.length,21);assert.equal(blocks.reduce((sum,e)=>sum+e.damage,0),2);assert.equal(m.fighters[1].hp,123);assert.equal(m.fighters[1].controlled,0);
});
test('pause freezes health, pulse index and control timers then resumes exactly once',()=>{
 const m=cast(playing());const first=advance(m,.65);m.paused=true;const frozen=JSON.stringify(m.fighters);advance(m,2);assert.equal(JSON.stringify(m.fighters),frozen);
 m.paused=false;const rest=advance(m,3);assert.equal([...first,...rest].filter(e=>e.type==='hit').length,21);assert.equal(m.fighters[1].hp,104);
});
test('a hit during laughter windup cancels the remaining pulses',()=>{
 const m=playing();m.fighters[1].x=610;step(m,{skill:true},1/120,{light:true});const events=advance(m,3);
 assert.equal(m.fighters[0].hp,ROSTER.niwa.health-7);assert.equal(m.fighters[0].move,null);assert.equal(events.filter(e=>e.type==='sonic').length,0);
});
test('an incoming ranged hit can interrupt active laughter without leaving background pulses',()=>{
 const m=playing('whale');m.fighters[1].x=740;step(m,{skill:true},1/120,{skill:true});const events=advance(m,3,{}, {skill:true});
 assert.ok(m.fighters[0].hp<110);assert.ok(events.filter(e=>e.type==='sonic').length<21);assert.equal(m.fighters[0].move,null);
 const hp=m.fighters[1].hp;advance(m,1);assert.equal(m.fighters[1].hp,hp);
});
test('knockout ends after the necessary one-point hits, clearing control and future waves',()=>{
 const m=playing();m.fighters[1].hp=3;cast(m);const events=advance(m,3);assert.equal(m.phase,'finished');assert.equal(m.stats.playerHits,3);assert.equal(m.fighters[1].controlled,0);assert.equal(events.filter(e=>e.type==='sonic').length,3);
});
test('computer-side laughter uses the same budget and restart has no stored damage or control',()=>{
 const m=createMatch('daodun','niwa');advance(m,2.3);m.fighters[0].x=500;m.fighters[1].x=650;advance(m,3,{}, {skill:true});assert.equal(m.fighters[0].hp,104);assert.equal(m.stats.cpuHits,21);
 const fresh=createMatch('niwa','daodun');advance(fresh,3);assert.equal(fresh.fighters[1].hp,125);assert.equal(fresh.fighters[1].controlled,0);assert.equal(fresh.fighters[0].move,null);
});
