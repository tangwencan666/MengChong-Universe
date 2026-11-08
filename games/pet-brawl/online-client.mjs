// Only same-origin local game endpoints. Ephemeral per-tab identity stays in memory.
// No account, model key, arbitrary URL, remote command, or client-authored world state.
export class BrawlClient {
  constructor({onMessage,onConnection}={}){
    this.onMessage=onMessage??(()=>{});this.onConnection=onConnection??(()=>{});
    this.token=null;this.closed=false;this.ready=false;this.seq=0;this.input={};this.pressed={};this.inFlight=false;this.pending=false;this.forceRelease=false;
  }
  async connect(){
    this.abort=new AbortController();this.connectTimer=setTimeout(()=>this.close(),10000);
    const response=await fetch('/api/brawl/session',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}',signal:this.abort.signal});
    const data=await response.json();if(!response.ok)throw Error(data.error||'无法建立联机身份');this.token=data.token;
    let resolve,reject;const first=new Promise((a,b)=>{resolve=a;reject=b;});
    this.rejectConnect=reject;this.stream(resolve,reject);this.heartbeat=setInterval(()=>this.flush(),100);
    await first;
  }
  async stream(firstResolve,firstReject){
    while(!this.closed){
      try{
        const response=await fetch('/api/brawl/events',{headers:{Authorization:`Bearer ${this.token}`},signal:this.abort.signal});
        if(response.status===401&&this.opened){this.onMessage({type:'lobby',status:'idle',message:'联机身份已过期，请重新进入'});this.close();break;}
        if(!response.ok)throw Error('联机连接暂不可用');
        this.ready=true;this.opened=true;clearTimeout(this.connectTimer);this.onConnection(true);firstResolve();
        const reader=response.body.getReader(),decoder=new TextDecoder();let buffer='';
        while(!this.closed){
          const {done,value}=await reader.read();if(done)break;buffer+=decoder.decode(value,{stream:true});
          if(buffer.length>262144)throw Error('联机数据过大');
          let boundary;while((boundary=buffer.indexOf('\n\n'))>=0){const block=buffer.slice(0,boundary);buffer=buffer.slice(boundary+2);const data=block.split('\n').filter(line=>line.startsWith('data: ')).map(line=>line.slice(6)).join('\n');if(data)this.onMessage(JSON.parse(data));}
        }
      }catch(error){if(this.closed)break;if(!this.opened){firstReject(error);this.close();break;}}
      if(!this.closed){this.ready=false;this.onConnection(false);await new Promise(resolve=>{this.retry=setTimeout(resolve,1000);this.retryResolve=resolve;});}
    }
  }
  async action(type,values={}){
    if(!this.token||this.closed)throw Error('联机连接已关闭');
    const response=await fetch('/api/brawl/action',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${this.token}`},body:JSON.stringify({type,...values})});
    const data=await response.json();if(!response.ok)throw Error(data.error||'联机操作失败');return data;
  }
  setInput(input,{release=false}={}){
    if(!release&&['left','right','jump','light','heavy','skill','guard','dash'].every(key=>Boolean(input[key])===Boolean(this.input[key])))return;
    for(const key of ['jump','light','heavy','skill','dash'])if(input[key]&&!this.input[key])this.pressed[key]=true;
    this.input={...input};if(release)this.pressed={};this.pending=true;this.forceRelease||=release;this.flush();
  }
  async flush(){
    if(this.closed||!this.ready||!this.playing||this.inFlight)return;
    this.inFlight=true;this.pending=false;
    const input={...this.input},pressed=this.pressed,release=this.forceRelease;this.pressed={};this.forceRelease=false;
    try{await this.action('input',{round:this.round,seq:++this.seq,input,pressed,release});}catch{/* State stream reports room end/disconnect; never retry a command with the same seq. */}
    finally{this.inFlight=false;if(this.pending)this.flush();}
  }
  async leave(){this.playing=false;try{await this.action('leave');}finally{this.close();}}
  close(){this.closed=true;this.ready=false;clearInterval(this.heartbeat);clearTimeout(this.connectTimer);clearTimeout(this.retry);this.retryResolve?.();this.abort?.abort();if(!this.opened)this.rejectConnect?.(Error('联机连接已取消或超时'));this.token=null;}
}
