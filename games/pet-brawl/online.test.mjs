import test from 'node:test';
import assert from 'node:assert/strict';
import {LocalArena,ArenaError} from './online-service.mjs';
function fixture(t){let time=1000;const arena=new LocalArena({now:()=>time,autoTick:false});t.after(()=>arena.close());return{arena,advance(seconds){for(let i=0;i<Math.ceil(seconds*60);i++){time+=1000/60;arena.tick();}},skip(ms){time+=ms;arena.tick();}};}
function player(arena){const token=arena.session(),messages=[];const detach=arena.attach(token,m=>messages.push(m));return{token,messages,detach};}
function pair(arena,a='niwa',b='daodun'){const p=player(arena),q=player(arena),{code}=arena.action(p.token,{type:'create',character:a});arena.action(q.token,{type:'join',character:b,code});return{p,q,room:arena.rooms.get(arena.player(p.token).room),code};}
const errorStatus=(fn,status)=>assert.throws(fn,e=>e instanceof ArenaError&&e.status===status);
test('invitation codes connect exactly two separate players, including identical characters',t=>{
 const{arena}=fixture(t),{p,q,room,code}=pair(arena,'whale','whale');assert.match(code,/^[A-HJ-NP-Z2-9]{8}$/);assert.equal(room.status,'playing');assert.deepEqual(room.state.fighters.map(f=>f.id),['whale','whale']);assert.equal(arena.player(p.token).side,0);assert.equal(arena.player(q.token).side,1);
 const third=player(arena);errorStatus(()=>arena.action(third.token,{type:'join',character:'niwa',code}),409);assert.equal(arena.player(third.token).room,null);
});
test('random matching never consumes an invitation room or creates a computer opponent',t=>{
 const{arena}=fixture(t),host=player(arena),a=player(arena),b=player(arena),c=player(arena);arena.action(host.token,{type:'create',character:'niwa'});
 arena.action(a.token,{type:'queue',character:'whale'});assert.equal(arena.player(a.token).room,null);arena.action(b.token,{type:'queue',character:'daodun'});arena.action(c.token,{type:'queue',character:'niwa'});
 assert.equal(arena.player(a.token).room,arena.player(b.token).room);assert.notEqual(arena.player(host.token).room,arena.player(a.token).room);assert.equal(arena.player(c.token).room,null);assert.equal(arena.queue.length,1);
});
test('only owning session controls its side; forged health, side and unknown identity are rejected',t=>{
 const f=fixture(t),{p,q,room}=pair(f.arena);f.advance(2.3);const before=room.state.fighters.map(v=>v.x);
 f.arena.action(q.token,{type:'input',round:room.roundId,seq:1,input:{left:true}});f.advance(.1);assert.equal(room.state.fighters[0].x,before[0]);assert.ok(room.state.fighters[1].x<before[1]);
 errorStatus(()=>f.arena.action(p.token,{type:'input',round:room.roundId,seq:2,input:{hp:999}}),400);errorStatus(()=>f.arena.action(p.token,{type:'input',round:room.roundId,seq:2,input:{right:true},side:1}),400);errorStatus(()=>f.arena.action('unknown',{type:'leave'}),401);
});
test('both clients receive one authoritative state and private rooms never receive each other snapshots',t=>{
 const f=fixture(t),a=pair(f.arena),b=pair(f.arena);f.advance(2.5);
 const left=a.p.messages.at(-1),right=a.q.messages.at(-1);assert.equal(left.room,right.room);assert.deepEqual(left.state,right.state);assert.equal(left.side,0);assert.equal(right.side,1);
 assert.ok(a.p.messages.every(m=>m.type!=='room'||m.room===a.room.id));assert.ok(b.q.messages.every(m=>m.type!=='room'||m.room===b.room.id));assert.equal('random'in left.state,false);assert.equal('ai'in left.state,false);
});
test('out-of-order and duplicated input sequence numbers cannot overwrite newer controls',t=>{
 const f=fixture(t),{p,room}=pair(f.arena);f.advance(2.3);const x=room.state.fighters[0].x;
 f.arena.action(p.token,{type:'input',round:room.roundId,seq:10,input:{right:true}});assert.equal(f.arena.action(p.token,{type:'input',round:room.roundId,seq:9,input:{left:true}}).accepted,false);assert.equal(f.arena.action(p.token,{type:'input',round:room.roundId,seq:10,input:{left:true}}).accepted,false);f.advance(.1);assert.ok(room.state.fighters[0].x>x);
});
test('a short pressed jump survives keyup before the next server tick exactly once',t=>{
 const f=fixture(t),{p,room}=pair(f.arena);f.advance(2.3);
 f.arena.action(p.token,{type:'input',round:room.roundId,seq:1,input:{},pressed:{jump:true}});f.arena.action(p.token,{type:'input',round:room.roundId,seq:2,input:{}});f.advance(.05);assert.ok(room.state.fighters[0].y>0);f.advance(1.6);assert.equal(room.state.fighters[0].y,0);
});
test('focus release and a stale input lease stop movement and pending taps',t=>{
 const f=fixture(t),{p,room}=pair(f.arena);f.advance(2.3);
 f.arena.action(p.token,{type:'input',round:room.roundId,seq:1,input:{right:true},pressed:{jump:true}});f.arena.action(p.token,{type:'input',round:room.roundId,seq:2,input:{},release:true});f.advance(.1);assert.equal(room.state.fighters[0].x,335);assert.equal(room.state.fighters[0].y,0);
 f.arena.action(p.token,{type:'input',round:room.roundId,seq:3,input:{right:true}});f.advance(.15);const x=room.state.fighters[0].x;f.skip(600);assert.equal(room.state.fighters[0].x,x);
});
test('disconnect suspends combat, reconnect resumes without catching up lost wall time',t=>{
 const f=fixture(t),{p,q,room}=pair(f.arena);f.advance(2.3);p.detach();const time=room.state.timeLeft;f.advance(1);assert.equal(room.state.timeLeft,time);assert.equal(room.state.paused,true);
 f.arena.attach(p.token,m=>p.messages.push(m));f.advance(.1);assert.equal(room.state.paused,false);assert.ok(time-room.state.timeLeft<.15);assert.equal(f.arena.player(q.token).room,room.id);
});
test('disconnect timeout closes the room rather than silently filling it with AI',t=>{
 const f=fixture(t),{p,q,room}=pair(f.arena);p.detach();f.skip(16000);assert.equal(f.arena.rooms.has(room.id),false);assert.equal(f.arena.player(q.token).room,null);assert.equal(q.messages.at(-1).type,'lobby');
});
test('queue cancellation and invitation expiry release membership safely',t=>{
 const f=fixture(t),p=player(f.arena);f.arena.action(p.token,{type:'queue',character:'niwa'});f.arena.action(p.token,{type:'leave'});assert.equal(f.arena.queue.length,0);
 const{code}=f.arena.action(p.token,{type:'create',character:'niwa'});f.skip(600001);const q=player(f.arena);errorStatus(()=>f.arena.action(q.token,{type:'join',character:'whale',code}),404);assert.equal(f.arena.player(p.token).room,null);
});
test('an unmatched queue expires with no simulated opponent',t=>{
 const f=fixture(t),p=player(f.arena);f.arena.action(p.token,{type:'queue',character:'niwa'});f.skip(120001);assert.equal(f.arena.queue.length,0);assert.equal(f.arena.player(p.token).room,null);assert.equal(p.messages.at(-1).status,'idle');
});
test('leaving a live room ends the peer game and does not change unrelated rooms',t=>{
 const f=fixture(t),a=pair(f.arena),b=pair(f.arena);f.arena.action(a.p.token,{type:'leave'});assert.equal(a.room.status,'aborted');assert.equal(a.q.messages.at(-1).status,'aborted');assert.equal(a.p.messages.at(-1).type,'lobby');assert.equal(b.room.status,'playing');
});
test('restarting a human match requires both players to agree',t=>{
 const f=fixture(t),{p,q,room}=pair(f.arena);f.advance(2.3);room.state.timeLeft=.001;f.advance(.1);assert.equal(room.status,'finished');const previous=room.roundId;
 f.arena.action(p.token,{type:'rematch'});assert.equal(room.roundId,previous);f.arena.action(q.token,{type:'rematch'});assert.notEqual(room.roundId,previous);assert.equal(room.state.phase,'countdown');assert.equal(room.state.fighters[0].hp,110);
});
test('bounded sessions and input rate limits reject resource abuse',t=>{
 const f=fixture(t),{p,room}=pair(f.arena);for(let i=0;i<50;i++)f.arena.action(p.token,{type:'input',round:room.roundId,seq:i,input:{}});errorStatus(()=>f.arena.action(p.token,{type:'input',round:room.roundId,seq:51,input:{}}),429);
 const tiny=new LocalArena({autoTick:false,maxSessions:1});t.after(()=>tiny.close());tiny.session();errorStatus(()=>tiny.session(),503);
});
test('service close releases every connection and room',t=>{const{arena}=fixture(t);let closed=0;const p=arena.session();arena.attach(p,()=>{},()=>closed++);arena.action(p,{type:'create',character:'niwa'});arena.close();assert.equal(closed,1);assert.equal(arena.rooms.size,0);assert.equal(arena.sessions.size,0);errorStatus(()=>arena.session(),503);});
test('late keys after knockout or leave are acknowledged as ignored without touching state',t=>{
 const f=fixture(t),{p,room}=pair(f.arena);f.advance(2.3);room.state.timeLeft=.001;f.advance(.1);const before=JSON.stringify(room.state.fighters);
 assert.equal(f.arena.action(p.token,{type:'input',round:room.roundId,seq:10,input:{right:true}}).accepted,false);assert.equal(JSON.stringify(room.state.fighters),before);
 f.arena.action(p.token,{type:'leave'});assert.equal(f.arena.action(p.token,{type:'input',round:room.roundId,seq:11,input:{right:true}}).accepted,false);
});
test('an old round cannot inject controls or poison sequence numbers in a rematch',t=>{
 const f=fixture(t),{p,q,room}=pair(f.arena);f.advance(2.3);const old=room.roundId;room.state.timeLeft=.001;f.advance(.1);f.arena.action(p.token,{type:'rematch'});f.arena.action(q.token,{type:'rematch'});
 assert.equal(f.arena.action(p.token,{type:'input',round:old,seq:999,input:{right:true}}).accepted,false);
 assert.equal(f.arena.action(p.token,{type:'input',round:room.roundId,seq:1,input:{}}).accepted,true);assert.deepEqual(f.arena.player(p.token).input,{});
});

