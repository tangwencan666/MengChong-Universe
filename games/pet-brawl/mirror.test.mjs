import test from 'node:test';
import assert from 'node:assert/strict';
import {ROSTER,createMatch,step,drainEvents} from './engine.mjs';
function advance(m,seconds,input={},cpu={}){for(let i=0;i<Math.ceil(seconds*120);i++)step(m,input,1/120,cpu);return m;}
function playing(id){const m=createMatch(id,id);advance(m,2.3);drainEvents(m);m.fighters[0].x=500;m.fighters[1].x=650;return m;}
for(const[id,damage,hits]of [['niwa',21,21],['daodun',20,2],['whale',16,3]])for(const side of [0,1])test(`${id} mirror side ${side} has independent health, stamina, cooldown and skill hits`,()=>{
 const m=playing(id),source=m.fighters[side],target=m.fighters[1-side];
 assert.notStrictEqual(source,target);assert.equal(source.id,target.id);assert.notEqual(source.side,target.side);
 step(m,side===0?{skill:true}:{},1/120,side===1?{skill:true}:{});
 assert.equal(source.stamina,72);assert.equal(source.skillCooldown,5.5);assert.equal(target.skillCooldown,0);
 advance(m,3);
 assert.equal(source.hp,ROSTER[id].health);assert.equal(target.hp,ROSTER[id].health-damage);
 assert.equal(m.stats[side===0?'playerHits':'cpuHits'],hits);assert.equal(m.stats[side===0?'cpuHits':'playerHits'],0);
 assert.ok(source.skillCooldown>0);assert.equal(target.skillCooldown,0);
});
test('simultaneous mirror knockout is a draw, independent of the shared character name',()=>{
 const m=playing('whale');m.fighters[1].x=610;m.fighters.forEach(f=>{f.hp=7;});advance(m,.3,{light:true},{light:true});
 assert.equal(m.phase,'finished');assert.equal(m.winner,'draw');assert.ok(m.fighters.every(f=>f.hp===0));
});
