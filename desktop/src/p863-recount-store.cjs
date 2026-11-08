'use strict';
const fs=require('node:fs'),path=require('node:path'),{randomUUID}=require('node:crypto');
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const TTL=7*86400000,LIMIT=512;
function createRecountStore(directory){
 let healthy=true,rows=[];const file=directory?path.join(directory,'pet-recounts-v1.json'):null;
 function check(){if(!file)return;if(!path.isAbsolute(directory))throw Error('Absolute profile required');const d=fs.lstatSync(directory);if(!d.isDirectory()||d.isSymbolicLink())throw Error('Unsafe profile');if(fs.existsSync(file)){const s=fs.lstatSync(file);if(!s.isFile()||s.isSymbolicLink()||s.size>131072)throw Error('Unsafe recount file');}}
 try{check();if(file&&fs.existsSync(file)){const v=JSON.parse(fs.readFileSync(file,'utf8'));if(v.version!==1||!Array.isArray(v.rows)||v.rows.length>LIMIT||!v.rows.every(r=>UUID.test(r.owner)&&UUID.test(r.pet)&&UUID.test(r.event)&&Number.isSafeInteger(r.at)&&r.at>=0))throw Error('Invalid recount ledger');rows=v.rows;}}catch{healthy=false;}
 return{get healthy(){return healthy;},has(owner,pet,event){return rows.some(r=>r.owner===owner&&r.pet===pet&&r.event===event);},cooling(owner,pet,at){return rows.some(r=>r.owner===owner&&r.pet===pet&&at-r.at>=0&&at-r.at<45000);},consume(owner,pet,event,at){
  if(!healthy||![owner,pet,event].every(id=>UUID.test(id))||!Number.isSafeInteger(at)||at<0||this.has(owner,pet,event)||this.cooling(owner,pet,at))return false;
  const next=[...rows.filter(r=>r.at>=at-TTL&&r.at<=at+TTL),{owner,pet,event,at}].slice(-LIMIT);
  try{check();if(file){const temp=file+'.'+randomUUID()+'.tmp';fs.writeFileSync(temp,JSON.stringify({version:1,rows:next}),{flag:'wx',mode:0o600});fs.renameSync(temp,file);}rows=next;return true;}catch{healthy=false;return false;}
 }};
}
module.exports={createRecountStore};
