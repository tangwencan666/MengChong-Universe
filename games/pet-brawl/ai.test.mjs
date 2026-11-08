import test from 'node:test';
import assert from 'node:assert/strict';
import {createMatch,step,drainEvents} from './engine.mjs';
function advance(m,seconds,input={guard:true},override) {const events=[];for(let i=0;i<Math.ceil(seconds*120);i++){step(m,input,1/120,override);events.push(...drainEvents(m));}return events;}
function ready(cpu='daodun',difficulty='normal',player='daodun'){const m=createMatch(player,cpu,{difficulty,seed:78});advance(m,2.3,{},{});return m;}

for(const difficulty of ['easy','normal'])for(const id of ['niwa','daodun','whale'])test(`${difficulty} ${id} AI actually jumps and lands, with cooldown between takeoffs`,()=>{
 const m=createMatch('daodun',id,{difficulty,seed:78}),times=[],landings=[];
 for(let i=0;i<2400;i++){step(m,{guard:true});for(const e of drainEvents(m)){if(e.side===1&&e.type==='jump')times.push(m.elapsed);if(e.side===1&&e.type==='land')landings.push(m.elapsed);}}
 assert.ok(times.length>=2,`${id} should initiate actual jumps`);assert.ok(landings.length>=1);
 for(let i=1;i<times.length;i++)assert.ok(times[i]-times[i-1]>2,'AI must not bounce continuously');
});
test('normal difficulty chooses an approach jump more readily than easy, without a threat',()=>{
 const normal=ready(),easy=ready('daodun','easy');normal.random=easy.random=()=>.2;
 step(normal,{},1/120);step(easy,{},1/120);
 assert.equal(normal.fighters[1].grounded,false);assert.equal(easy.fighters[1].grounded,true);
});
test('AI jump is a one-frame tap and cannot repeat before its cooldown',()=>{
 const m=ready();m.random=()=>0;step(m,{},1/120);const first=drainEvents(m);
 assert.equal(m.ai.input.jump,true);step(m,{},1/120);assert.equal(m.ai.input.jump,false);
 const events=[...first,...advance(m,2,{})];assert.equal(events.filter(e=>e.type==='jump'&&e.side===1).length,1);assert.ok(m.ai.jumpCooldown>0);
});
test('a visible melee telegraph can trigger a jump instead of incompatible guard input',()=>{
 const m=ready('daodun','normal','niwa');m.fighters[1].x=500;m.random=()=>.4;
 step(m,{skill:true},1/120,{});drainEvents(m);step(m,{},1/120);
 assert.ok(m.fighters[0].move.sonic);assert.equal(m.fighters[1].grounded,false);assert.equal(m.ai.input.guard,false);assert.ok(m.fighters[1].y>0);
});
test('a real incoming low projectile triggers an evasive jump',()=>{
 const m=ready('daodun','normal','whale');m.fighters[1].x=650;
 advance(m,.27,{skill:true},{});assert.ok(m.projectiles.length>0);m.random=()=>.5;step(m,{},1/120);
 assert.equal(m.fighters[1].grounded,false);assert.ok(drainEvents(m).some(e=>e.type==='jump'&&e.side===1));
});
for(const restriction of ['airborne','stunned','attacking','dashing'])test(`AI respects ${restriction} state rather than forcing a jump`,()=>{
 const m=ready(),cpu=m.fighters[1];m.random=()=>0;
 if(restriction==='airborne'){cpu.grounded=false;cpu.y=150;}
 if(restriction==='stunned'){cpu.stun=1;cpu.controlled=1;}
 if(restriction==='attacking')step(m,{},1/120,{heavy:true});
 if(restriction==='dashing')step(m,{},1/120,{dash:true});
 drainEvents(m);step(m,{},1/120);assert.equal(drainEvents(m).filter(e=>e.type==='jump'&&e.side===1).length,0);assert.equal(m.ai.jumpCooldown,0);
});
test('pause freezes AI cooldown and jump state, and resume continues its existing flight',()=>{
 const m=ready();m.random=()=>0;step(m,{},1/120);drainEvents(m);m.paused=true;
 const frozen=JSON.stringify({ai:m.ai,cpu:m.fighters[1]});advance(m,3,{});assert.equal(JSON.stringify({ai:m.ai,cpu:m.fighters[1]}),frozen);
 m.paused=false;step(m,{},1/120);assert.equal(drainEvents(m).filter(e=>e.type==='jump'&&e.side===1).length,0);assert.ok(m.ai.jumpCooldown<2.4);
});
test('countdown and finished matches do not run AI jumps, restart has a fresh cooldown',()=>{
 const m=createMatch('daodun','whale');assert.equal(advance(m,1).filter(e=>e.type==='jump').length,0);assert.equal(m.ai.jumpCooldown,0);
 m.phase='finished';const frozen=JSON.stringify(m.ai);advance(m,2);assert.equal(JSON.stringify(m.ai),frozen);
 const fresh=createMatch('daodun','whale');assert.equal(fresh.ai.jumpCooldown,0);assert.equal(fresh.ai.input.jump,false);
});
