import {ArenaError} from './online-service.mjs';
const prefix='/api/brawl/';
export async function handleOnline(req,res,arena,headers){
  if(!req.url.startsWith(prefix))return false;
  const origin=`http://127.0.0.1:${req.socket.localPort}`;
  const reply=(status,value)=>{res.writeHead(status,{...headers,'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(value));};
  try{
    if(req.headers.origin&&req.headers.origin!==origin)throw new ArenaError(403,'仅允许本地同源请求');
    if(req.method==='POST'&&req.headers.origin!==origin)throw new ArenaError(403,'请求来源不正确');
    if(req.url==='/api/brawl/events'&&req.method==='GET'){
      const token=readToken(req);arena.player(token);
      res.writeHead(200,{...headers,'Content-Type':'text/event-stream; charset=utf-8','Connection':'keep-alive','X-Accel-Buffering':'no'});res.flushHeaders();
      res.on('error',()=>res.destroy());
      const send=value=>{if(res.destroyed||res.writableEnded)return;if(res.writableLength>131072){res.destroy();return;}res.write(`data: ${JSON.stringify(value)}\n\n`);};
      const detach=arena.attach(token,send,()=>res.end());
      const heartbeat=setInterval(()=>{if(!res.destroyed&&!res.writableEnded)res.write(': heartbeat\n\n');},10000).unref();
      res.on('close',()=>{clearInterval(heartbeat);detach();});return true;
    }
    if(req.method!=='POST'||!['/api/brawl/session','/api/brawl/action'].includes(req.url))throw new ArenaError(404,'接口不存在');
    if(!/^application\/json(?:;|$)/i.test(req.headers['content-type']??''))throw new ArenaError(415,'需要JSON请求');
    const body=await readBody(req);
    if(req.url==='/api/brawl/session'){
      if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).length)throw new ArenaError(400,'请求内容不正确');
      reply(201,{token:arena.session()});
    }else reply(200,arena.action(readToken(req),body));
  }catch(error){if(!res.headersSent)reply(error instanceof ArenaError?error.status:500,{error:error instanceof ArenaError?error.message:'本地联机服务暂不可用'});else res.end();}
  return true;
}
function readToken(req){const match=/^Bearer ([A-Za-z0-9_-]{32})$/.exec(req.headers.authorization??'');if(!match)throw new ArenaError(401,'联机身份无效');return match[1];}
function readBody(req){
  return new Promise((resolve,reject)=>{
    let size=0,chunks=[];req.on('data',chunk=>{size+=chunk.length;if(size<=4096)chunks.push(chunk);else chunks=[];});
    req.on('end',()=>{if(size>4096){reject(new ArenaError(413,'请求过大'));return;}try{resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));}catch{reject(new ArenaError(400,'JSON格式不正确'));}});
    req.on('error',()=>reject(new ArenaError(400,'请求中断')));
  });
}
