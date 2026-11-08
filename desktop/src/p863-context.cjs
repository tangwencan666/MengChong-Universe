'use strict';
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const moodLines={happy:'我现在心情不错，想和你待一会儿。',calm:'我现在挺平静，想听听你的近况。',curious:'我有点好奇，今天有没有新鲜事？',angry:'我现在有点不高兴，想慢慢缓一缓。',upset:'我有点委屈，可以陪我一会儿吗？',sad:'我现在有点难过，安静陪着也很好。',shy:'我有点害羞，不过很想和你聊聊。',sleepy:'我有点困了，想休息一会儿。'};
const descriptions={greeting:'打了个招呼',play:'一起玩了一会儿',cooperate:'一起做过一件小合作',conflict:'因为玩具闹过一点小别扭',reconcile:'后来和好了'};
const actions=new Set(['pet','comfort','chicken','fish','toy','blanket','mediate','support']);
const text=value=>typeof value==='string'?[...value.replace(/[\u0000-\u001f\u007f]/g,'')].slice(0,60).join(''):'';
function eventFacts({owner,pet,view,events,at}){
 if(view?.owner_id!==owner||!UUID.test(owner)||!UUID.test(pet)||!Array.isArray(events)||events.length>200)throw Error('Untrusted social scope');
 const known=new Set(view.pets.map(p=>p.id));
 return events.filter(e=>{
  if(!UUID.test(e.id)||!Array.isArray(e.participants)||!e.participants.includes(pet)||!e.participants.every(id=>UUID.test(id)&&known.has(id)))throw Error('Untrusted participants');
  return descriptions[e.kind]&&e.visibility==='participants'&&e.phase==='ended'&&e.participants.length>=2&&e.participants.length<=3&&new Set(e.participants).size===e.participants.length
   &&Number.isSafeInteger(e.started_at)&&e.started_at>=0&&Number.isSafeInteger(e.ended_at)&&e.ended_at>=e.started_at&&e.ended_at<=at&&e.ended_at>=at-7*86400000
   &&['friendly','settled','comforted','supported'].includes(e.outcome);
 }).sort((a,b)=>b.ended_at-a.ended_at).map(e=>({event_id:e.id,kind:e.kind,participant_ids:[...e.participants],started_at:e.started_at,ended_at:e.ended_at,outcome:e.outcome,user_actions:(e.user_actions??[]).filter(a=>a.pet===pet&&actions.has(a.action)&&Number.isSafeInteger(a.at)&&a.at>=e.started_at&&a.at<=e.ended_at).slice(0,8).map(a=>({action:a.action,pet:a.pet,at:a.at}))}));
}
function makeCompanionContext({owner,pet,sessionId=null,instance,view,events,names={},at,mode='peek',ledger}){
 if(!UUID.test(owner)||!UUID.test(pet)||(sessionId!==null&&!UUID.test(sessionId))||!['peek','recount'].includes(mode)
  ||instance?.owner_user_id!==owner||instance?.pet_instance_id!==pet||instance?.pet_id!==pet||instance.status!=='active'
  ||instance.personality_snapshot_version!==instance.version||!Number.isSafeInteger(instance.version)||instance.version<1
  ||typeof instance.personality_snapshot?.description!=='string'||instance.personality_snapshot.description.length>600
  ||!['warm','calm','playful'].includes(instance.personality_snapshot.tone))throw Error('Untrusted companion identity');
 const facts=view?eventFacts({owner,pet,view,events,at}):[];
 const own=view?.pets.find(p=>p.id===pet),mood=Object.hasOwn(moodLines,own?.mood)?own.mood:null;
 let story=null,reason='idle';
 if(mode==='recount'){
  if(!ledger?.healthy)reason='unavailable';
  else if(ledger.cooling(owner,pet,at))reason='cooldown';
  else{
   const candidate=facts.find(e=>!ledger.has(owner,pet,e.event_id));
   if(candidate&&ledger.consume(owner,pet,candidate.event_id,at)){
    const peers=candidate.participant_ids.filter(id=>id!==pet).map(id=>'「'+(text(names[id])||'那位伙伴')+'」').join('、');
    const opening={warm:'想和你分享一件小事。',playful:'嘿嘿，想起一件小事。',calm:'我想起一段和伙伴的经历。'}[instance.personality_snapshot.tone];
    const user=candidate.user_actions.some(a=>a.action==='comfort')?'这件事里，你也安慰过我。':'';
    story={event_id:candidate.event_id,text:`${opening}我和${peers}${descriptions[candidate.kind]}。${user}`,source:'local-event'};reason='shared';
   }else reason=facts.length?'already-shared':'no-event';
  }
 }
 return{schema:'pet-local-context/1',owner_id:owner,pet_id:pet,session_id:sessionId,persona_snapshot:{description:instance.personality_snapshot.description,tone:instance.personality_snapshot.tone},persona_version:instance.version,
  mood,mood_line:mood?moodLines[mood]:'还没有我的桌面活动状态。想聊聊今天的事吗？',events:facts.slice(0,3),source_event_ids:facts.map(e=>e.event_id),story,reason,
  model_injection:false,rag:false,context_boundary:{history:'server-session-scoped',long_term_memory:'server-consent-scoped'}};
}
module.exports={eventFacts,makeCompanionContext,moodLines};
