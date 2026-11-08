import {randomBytes,randomUUID} from 'node:crypto';
import {ROSTER,createMatch,step,drainEvents} from './engine.mjs';

export class ArenaError extends Error {
  constructor(status,message){super(message);this.status=status;}
}
const fail=(status,message)=>{throw new ArenaError(status,message);};
const keys=new Set(['left','right','jump','light','heavy','skill','guard','dash']);
const taps=['jump','light','heavy','skill','dash'];
const alphabet='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const isObject=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
function exact(value,allowed){if(!isObject(value)||Object.keys(value).some(k=>!allowed.includes(k)))fail(400,'请求内容不正确');}

// Local prototype only: in-memory, bounded rooms; never touches accounts or databases.
// Both fighters are driven by inputs here. The engine's CPU is never used online.
export class LocalArena {
  constructor({now=()=>Date.now(),autoTick=true,maxSessions=64,maxRooms=24}={}){
    this.now=now;this.maxSessions=maxSessions;this.maxRooms=maxRooms;
    this.sessions=new Map();this.rooms=new Map();this.queue=[];this.closed=false;this.autoTick=autoTick;
  }
  session(){
    if(this.closed)fail(503,'联机服务已停止');
    if(this.sessions.size>=this.maxSessions)fail(503,'本地联机人数已满');
    if(this.autoTick&&!this.timer)this.timer=setInterval(()=>this.tick(),1000/60).unref();
    const token=randomBytes(24).toString('base64url'),now=this.now();
    this.sessions.set(token,{token,created:now,touched:now,send:null,close:null,disconnectedAt:now,room:null,character:null,side:null,queuedAt:null,input:{},pending:{},seq:-1,inputAt:0,rateAt:now,rate:0,actions:[],rematch:false});
    return token;
  }
  player(token){const player=this.sessions.get(token);if(!player)fail(401,'联机身份已失效，请重新进入');player.touched=this.now();return player;}
  attach(token,send,close=()=>{}){
    const player=this.player(token),previous=player.close;
    player.send=send;player.close=close;player.disconnectedAt=null;if(previous)previous();
    const room=this.rooms.get(player.room);if(room){this.maybeStart(room);this.publish(room);}else this.sendLobby(player);
    return()=>{
      if(player.send!==send)return;
      player.send=null;player.close=null;player.disconnectedAt=this.now();player.input={};player.pending={};
      this.queue=this.queue.filter(t=>t!==token);player.queuedAt=null;
      const room=this.rooms.get(player.room);if(room&&room.state&&room.status==='playing'){room.state.paused=true;room.lastTick=this.now();this.publish(room);}
    };
  }
  sendLobby(player,message=''){
    player.send?.({type:'lobby',status:player.queuedAt!==null?'queued':'idle',message,queuedAt:player.queuedAt});
  }
  action(token,body){
    const player=this.player(token);if(!isObject(body)||typeof body.type!=='string')fail(400,'请求内容不正确');
    if(body.type==='input')return this.input(player,body);
    const now=this.now();player.actions=player.actions.filter(t=>now-t<10000);
    if(player.actions.length>=12)fail(429,'操作太频繁，请稍后再试');player.actions.push(now);
    if(body.type==='leave'){exact(body,['type']);this.leave(player);return{ok:true};}
    if(body.type==='rematch'){
      exact(body,['type']);const room=this.rooms.get(player.room);
      if(!room||room.status!=='finished')fail(409,'当前不能申请重开');
      player.rematch=true;if(room.members.every(t=>this.sessions.get(t)?.rematch&&this.sessions.get(t)?.send))this.start(room);this.publish(room);return{ok:true};
    }
    exact(body,body.type==='join'?['type','character','code']:['type','character']);
    if(!Object.hasOwn(ROSTER,body.character))fail(400,'请选择有效角色');
    if(!['create','join','queue'].includes(body.type))fail(400,'不支持的联机操作');
    if(!player.send)fail(409,'请等待联机连接就绪');
    if(player.queuedAt!==null||player.room)fail(409,'请先取消当前匹配或离开房间');
    player.character=body.character;
    if(body.type==='create'){
      if(this.rooms.size>=this.maxRooms)fail(503,'本地房间已满');
      let code;do{code=Array.from(randomBytes(8),n=>alphabet[n%32]).join('');}while([...this.rooms.values()].some(r=>r.code===code));
      const room={id:randomUUID(),code,private:true,members:[token],created:now,expires:now+600000,status:'waiting',state:null,roundId:null,events:[],accumulator:0,lastTick:now,lastPublish:now};
      this.rooms.set(room.id,room);player.room=room.id;player.side=0;this.publish(room);return{ok:true,code,expires:room.expires};
    }
    if(body.type==='join'){
      if(typeof body.code!=='string'||!/^[A-HJ-NP-Z2-9]{8}$/.test(body.code))fail(400,'格斗码为8位大写字母或数字');
      const room=[...this.rooms.values()].find(r=>r.private&&r.code===body.code);
      if(!room||room.expires<=now)fail(404,'格斗码不存在或已过期');
      if(room.members.includes(token))fail(409,'不能加入自己的房间');
      if(room.status!=='waiting'||room.members.length!==1)fail(409,'房间已满或已结束');
      if(!this.sessions.get(room.members[0])?.send)fail(409,'房主暂未连接');
      room.members.push(token);player.room=room.id;player.side=1;this.maybeStart(room);this.publish(room);return{ok:true};
    }
    this.queue=this.queue.filter(t=>{const p=this.sessions.get(t);return p&&p.send&&!p.room&&p.queuedAt!==null&&now-p.queuedAt<120000;});
    const opponentToken=this.queue.shift(),opponent=this.sessions.get(opponentToken);
    if(opponent){
      if(this.rooms.size>=this.maxRooms){this.queue.unshift(opponentToken);fail(503,'本地房间已满');}
      const room={id:randomUUID(),code:null,private:false,members:[opponentToken,token],created:now,expires:now+600000,status:'waiting',state:null,roundId:null,events:[],accumulator:0,lastTick:now,lastPublish:now};
      this.rooms.set(room.id,room);opponent.queuedAt=null;player.queuedAt=null;
      for(const [side,t]of room.members.entries()){const p=this.sessions.get(t);p.room=room.id;p.side=side;}
      this.maybeStart(room);this.publish(room);return{ok:true};
    }
    player.queuedAt=now;this.queue.push(token);this.sendLobby(player);return{ok:true};
  }
  input(player,body){
    exact(body,['type','round','seq','input','pressed','release']);
    if(typeof body.round!=='string'||body.round.length>64||!Number.isSafeInteger(body.seq)||body.seq<0||body.seq>1e12||!isObject(body.input)||Object.entries(body.input).some(([k,v])=>!keys.has(k)||typeof v!=='boolean')||(body.pressed!==undefined&&(!isObject(body.pressed)||Object.entries(body.pressed).some(([k,v])=>!taps.includes(k)||typeof v!=='boolean')))||(body.release!==undefined&&typeof body.release!=='boolean'))fail(400,'只允许发送合法按键');
    const now=this.now();if(now-player.rateAt>=1000){player.rateAt=now;player.rate=0;}if(++player.rate>50)fail(429,'按键发送过快');
    const room=this.rooms.get(player.room);
    // In-flight keys may arrive after KO/leave/rematch. Ignore them without changing
    // the world or advancing the sequence of the current round.
    if(!room||room.status!=='playing'||body.round!==room.roundId)return{ok:true,accepted:false,lastSeq:player.seq,reason:'round-ended'};
    if(body.seq<=player.seq)return{ok:true,accepted:false,lastSeq:player.seq};
    player.seq=body.seq;player.inputAt=now;
    if(body.release){player.input={};player.pending={};}
    else{
      for(const key of taps)if(body.pressed?.[key]||(body.input[key]&&!player.input[key]))player.pending[key]=true;
      player.input={...body.input};
    }
    return{ok:true,accepted:true,lastSeq:player.seq};
  }
  maybeStart(room){if(room.status==='waiting'&&room.members.length===2&&room.members.every(t=>this.sessions.get(t)?.send))this.start(room);}
  start(room){
    const players=room.members.map(t=>this.sessions.get(t));
    room.state=createMatch(players[0].character,players[1].character,{seed:randomBytes(4).readUInt32LE()});
    room.status='playing';room.roundId=randomUUID();room.events=[];room.accumulator=0;room.lastTick=this.now();
    for(const player of players){player.input={};player.pending={};player.inputAt=this.now();player.rematch=false;}
  }
  publish(room){
    let state=null;
    if(room.state){const{random,ai,events,...visible}=room.state;state=structuredClone(visible);}
    for(const token of room.members){const p=this.sessions.get(token);p?.send?.({type:'room',room:room.id,roundId:room.roundId,status:room.status,side:p.side,characters:room.members.map(t=>this.sessions.get(t)?.character),code:room.code,expires:room.expires,state,events:room.events,message:room.message??'',rematch:room.members.map(t=>Boolean(this.sessions.get(t)?.rematch))});}
    room.events=[];room.lastPublish=this.now();
  }
  leave(player){
    this.queue=this.queue.filter(t=>t!==player.token);player.queuedAt=null;
    const room=this.rooms.get(player.room);player.room=null;player.side=null;player.input={};player.pending={};player.rematch=false;
    if(room){room.members=room.members.filter(t=>t!==player.token);room.status='aborted';room.message='对手已离开，本局结束';room.expires=this.now()+30000;if(room.state)room.state.paused=true;this.publish(room);if(!room.members.length)this.rooms.delete(room.id);}
    this.sendLobby(player);
  }
  tick(){
    if(this.closed)return;const now=this.now();
    for(const room of [...this.rooms.values()]){
      if(room.status==='waiting'&&now>=room.expires){this.endRoom(room,'格斗码已过期，请重新创建');continue;}
      if(room.members.some(t=>{const p=this.sessions.get(t);return !p||(p.disconnectedAt!==null&&now-p.disconnectedAt>15000);})){this.endRoom(room,'连接中断超过15秒，本局结束');continue;}
      if((room.status==='finished'||room.status==='aborted')&&now>=room.expires){this.endRoom(room,'房间已关闭');continue;}
      if(room.status!=='playing')continue;
      const players=room.members.map(t=>this.sessions.get(t)),connected=players.every(p=>p.send);
      if(!connected){room.state.paused=true;room.lastTick=now;continue;}
      if(room.state.paused){room.state.paused=false;room.lastTick=now;}
      room.accumulator+=Math.min(.1,Math.max(0,(now-room.lastTick)/1000));room.lastTick=now;
      while(room.accumulator>=1/120&&room.state.phase!=='finished'){
        for(const p of players)if(now-p.inputAt>500){p.input={};p.pending={};}
        step(room.state,{...players[0].input,...players[0].pending},1/120,{...players[1].input,...players[1].pending});
        for(const p of players)p.pending={};room.events.push(...drainEvents(room.state));if(room.events.length>64)room.events.splice(0,room.events.length-64);room.accumulator-=1/120;
      }
      if(room.state.phase==='finished'){room.status='finished';room.expires=now+120000;this.publish(room);}
      else if(now-room.lastPublish>=50)this.publish(room);
    }
    for(const p of [...this.sessions.values()]){
      if(p.queuedAt!==null&&now-p.queuedAt>120000){this.queue=this.queue.filter(t=>t!==p.token);p.queuedAt=null;this.sendLobby(p,'暂未匹配到真人，可以重新匹配或选择人机对战');}
      if((p.disconnectedAt!==null&&!p.room&&p.queuedAt===null&&now-p.disconnectedAt>15000)||now-p.touched>1800000||now-p.created>3600000){this.leave(p);p.close?.();this.sessions.delete(p.token);}
    }
    if(!this.sessions.size&&this.timer){clearInterval(this.timer);this.timer=null;}
  }
  endRoom(room,message){
    for(const token of room.members){const p=this.sessions.get(token);if(p){p.room=null;p.side=null;p.input={};p.pending={};p.rematch=false;this.sendLobby(p,message);}}
    this.rooms.delete(room.id);
  }
  close(){if(this.closed)return;this.closed=true;clearInterval(this.timer);for(const p of this.sessions.values())p.close?.();this.sessions.clear();this.rooms.clear();this.queue=[];}
}
