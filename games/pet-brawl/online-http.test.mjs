import test from 'node:test';
import assert from 'node:assert/strict';
import {createGameServer} from './server.mjs';
async function fixture(t){const server=createGameServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`,aborters=[];t.after(async()=>{for(const c of aborters)c.abort();await new Promise(r=>server.close(r));});
 const post=(path,body,token,extra={})=>fetch(base+path,{method:'POST',headers:{Origin:base,'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{ }),...extra},body:typeof body==='string'?body:JSON.stringify(body)});
 const session=async()=>{const r=await post('/api/brawl/session',{});assert.equal(r.status,201);return(await r.json()).token;};
 const stream=async token=>{const c=new AbortController();aborters.push(c);const r=await fetch(base+'/api/brawl/events',{headers:{Authorization:`Bearer ${token}`},signal:c.signal});assert.equal(r.status,200);return r;};
 return{server,base,post,session,stream};}
test('local HTTP protocol creates two independent per-tab identities and connects by code',async t=>{
 const f=await fixture(t),a=await f.session(),b=await f.session();assert.notEqual(a,b);await f.stream(a);await f.stream(b);
 const created=await f.post('/api/brawl/action',{type:'create',character:'whale'},a),data=await created.json();assert.equal(created.status,200);assert.match(data.code,/^[A-HJ-NP-Z2-9]{8}$/);
 assert.equal((await f.post('/api/brawl/action',{type:'join',character:'whale',code:data.code},b)).status,200);
  assert.equal((await f.post('/api/brawl/action',{type:'input',seq:1,input:{right:true}},a)).status,400);
});
test('origin, bearer identity and route boundaries reject cross-origin or unauthenticated operations',async t=>{
 const f=await fixture(t);assert.equal((await f.post('/api/brawl/session',{},null,{Origin:'https://other.invalid'})).status,403);
 assert.equal((await fetch(f.base+'/api/brawl/session',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,403);
 assert.equal((await f.post('/api/brawl/action',{type:'leave'})).status,401);assert.equal((await fetch(f.base+'/api/brawl/events')).status,401);
 assert.equal((await f.post('/api/brawl/unknown',{})).status,404);assert.equal((await fetch(f.base+'/online-service.mjs')).status,404);
});
test('HTTP body size, content type and illegal authoritative fields are bounded',async t=>{
 const f=await fixture(t);assert.equal((await f.post('/api/brawl/session',{},null,{'Content-Type':'text/plain'})).status,415);assert.equal((await f.post('/api/brawl/session','not-json')).status,400);assert.equal((await f.post('/api/brawl/session',JSON.stringify({padding:'x'.repeat(5000)}))).status,413);
 const token=await f.session();await f.stream(token);assert.equal((await f.post('/api/brawl/action',{type:'queue',character:'niwa',hp:999},token)).status,400);assert.equal((await f.post('/api/brawl/action',{type:'queue',character:'unknown'},token)).status,400);
});
test('server close terminates its own active streams and releases the listener',async()=>{
 const server=createGameServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
 const response=await fetch(base+'/api/brawl/session',{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:'{}'}),{token}=await response.json();const abort=new AbortController();
 const stream=await fetch(base+'/api/brawl/events',{headers:{Authorization:`Bearer ${token}`},signal:abort.signal});assert.equal(stream.status,200);await new Promise(r=>server.close(r));assert.equal(server.listening,false);abort.abort();
});
