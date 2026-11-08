'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {makeCompanionContext,eventFacts}=require('../src/p863-context.cjs'),{createRecountStore}=require('../src/p863-recount-store.cjs');
const {createSociety,triggerForTest}=require('../src/p86-society.cjs'),{posture}=require('../renderer/pet-mood.js');
const [OWNER,PET,PEER,OTHER,SID]=[1,2,3,4,5].map(n=>`10000000-0000-4000-8000-${String(n).padStart(12,'0')}`);
function fixture(){
 const engine=createSociety({owner:OWNER,now:1000,seed:1});
 for(const id of [PET,PEER,OTHER])engine.setPresence({id,species:'hajimi',visible:true,available:true,random:true,autoMove:false,display:'one',x:100,y:100},1000);
 assert.equal(triggerForTest(engine,'cooperate',[PET,PEER],1000),true);engine.advance(12000);
 const instance={owner_user_id:OWNER,pet_id:PET,pet_instance_id:PET,status:'active',version:1,personality_snapshot_version:1,personality_snapshot:{description:'温柔而独立',tone:'warm'}};
 const args={owner:OWNER,pet:PET,sessionId:SID,instance,view:engine.view(OWNER,12000),events:engine.eventsFor(OWNER,PET),names:{[PEER]:'同名伙伴'},at:12000,mode:'recount',ledger:createRecountStore()};
 return{engine,args,read:patch=>makeCompanionContext({...args,...patch})};
}
test('an actual seeded shared event yields one factual local story, no invented user action or AI claim',()=>{
 const {args,read}=fixture(),v=read();assert.match(v.story.text,/同名伙伴.*合作/);assert.doesNotMatch(v.story.text,/安慰过|抢我|支持了/);
 assert.equal(v.story.source,'local-event');assert.equal(v.model_injection,false);assert.equal(v.rag,false);
 assert.deepEqual(v.events[0].participant_ids,[PET,PEER]);assert.equal(v.persona_snapshot.description,args.instance.personality_snapshot.description);
 assert.equal(read().story,null);assert.equal(read().reason,'cooldown');assert.equal(read({at:60000}).reason,'already-shared');
});
test('peek never consumes an event; unrelated instance and owner cannot read private events',()=>{
 const {args,read}=fixture();assert.equal(read({mode:'peek'}).story,null);assert.ok(read().story);
 assert.throws(()=>read({owner:OTHER}));assert.throws(()=>read({pet:OTHER}));
 assert.throws(()=>eventFacts({...args,pet:OTHER}));
 assert.equal(makeCompanionContext({...args,pet:OTHER,instance:{...args.instance,pet_id:OTHER,pet_instance_id:OTHER},events:[],ledger:createRecountStore()}).reason,'no-event');
});
test('deleting a real event removes it from every subsequent assembly and never manufactures a replacement',()=>{
 const {args,engine,read}=fixture();const id=read().story.event_id;engine.deleteEvent(OWNER,id,13000);
 const next=read({view:engine.view(OWNER,13000),events:engine.eventsFor(OWNER,PET),at:60000});assert.equal(next.story,null);assert.deepEqual(next.source_event_ids,[]);assert.equal(next.reason,'no-event');
});
test('incomplete, future, stale and nonparticipant visibility events cannot become a factual story',()=>{
 const {args,read}=fixture();for(const patch of [{ended_at:null},{ended_at:14000},{visibility:'public'},{phase:'approach'},{kind:'stole_position'},{started_at:-1},{outcome:'interrupted'}]){
  assert.equal(read({events:[{...args.events[0],...patch}],ledger:createRecountStore()}).story,null);
 }
 assert.equal(read({at:8*86400000}).story,null);
});
test('only recorded comfort for this instance is stated, never a peer action',()=>{
 const {args,read}=fixture();const e={...args.events[0],user_actions:[{pet:PEER,action:'comfort',at:11000}]};
 assert.doesNotMatch(read({events:[e]}).story.text,/安慰过/);
 e.user_actions.push({pet:PET,action:'comfort',at:11000});assert.match(read({events:[e],ledger:createRecountStore()}).story.text,/你也安慰过我/);
});
test('pinned persona version, malformed identity and non-active instance fail closed',()=>{
 const {args,read}=fixture();for(const patch of [{version:2},{pet_instance_id:OTHER},{status:'archived'},{owner_user_id:OTHER},{personality_snapshot:{description:'x'.repeat(601),tone:'warm'}}])assert.throws(()=>read({instance:{...args.instance,...patch}}));
});
test('recount suppression persists across restart and rename, scoped to owner and pet without event bodies',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'p863-recount-'));t.after(()=>fs.rmSync(dir,{recursive:true}));
 const {args,read}=fixture();assert.ok(read({ledger:createRecountStore(dir)}).story);
 const restarted=createRecountStore(dir);assert.equal(read({ledger:restarted,at:60000,instance:{...args.instance,name:'新名字'}}).story,null);
 assert.equal(restarted.has(OWNER,PEER,args.events[0].id),false);assert.equal(restarted.has(OTHER,PET,args.events[0].id),false);
 const text=fs.readFileSync(path.join(dir,'pet-recounts-v1.json'),'utf8');assert.doesNotMatch(text,/同名伙伴|温柔|合作|description|text/);
});
test('corrupt recount storage is retained untouched and disables recount instead of repeating',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'p863-recount-'));t.after(()=>fs.rmSync(dir,{recursive:true}));const file=path.join(dir,'pet-recounts-v1.json');fs.writeFileSync(file,'invalid');
 assert.equal(fixture().read({ledger:createRecountStore(dir)}).reason,'unavailable');assert.equal(fs.readFileSync(file,'utf8'),'invalid');
});
test('real mood drives idle posture; dragging, AI, hiding and active animations retain priority',()=>{
 const base={social:{mood:'upset'},action:'idle',activity:'idle',state:'idle',visible:true};assert.equal(posture(base),'upset');
 for(const mood of ['happy','calm','curious','angry','upset','sad','shy','sleepy'])assert.equal(posture({...base,social:{mood}}),mood);
 for(const patch of [{state:'dragging'},{action:'jump'},{activity:'thinking'},{activity:'speaking'},{visible:false},{social:{mood:'invented'}}])assert.equal(posture({...base,...patch}),'none');
 assert.equal(posture(base,true),'none');assert.equal(posture({...base,social:{mood:'calm'}}),'calm');
});
test('the mood script is a permitted shipped resource and exports its browser presentation API',()=>{
 const policy=require('../src/policy.cjs'),base='http://127.0.0.1:35316',vm=require('node:vm');
 const html=fs.readFileSync(path.join(__dirname,'../renderer/pet.html'),'utf8');
 for(const match of html.matchAll(/<script src="\.\/([^"/]+)"/g))assert.equal(policy.petResource(base+'/__pet/'+match[1],base),true,match[1]);
 assert.equal(policy.petResource(base+'/__pet/untrusted-script.js',base),false);
 assert.equal(policy.petResource('https://outside.invalid/__pet/pet-mood.js',base),false);
 assert.equal(policy.petResource(base+'/api/v1/pets',base),false);
 const context={};vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../renderer/pet-mood.js'),'utf8'),context);
 assert.equal(context.WeiBiYePetMood.posture({social:{mood:'upset'},action:'idle'}),'upset');
});
