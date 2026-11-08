'use strict';
// Verification-only direct trust of a fresh local certificate; never packaged.
const fs=require('node:fs');
const path=require('node:path');
const {X509Certificate}=require('node:crypto');
const {app,session}=require('electron');
const arg=name=>{const at=process.argv.indexOf(name);if(at<0)throw Error('Missing owned test argument');return process.argv[at+1];};
const root=arg('--p83-app');
const certificate=new X509Certificate(fs.readFileSync(arg('--p83-certificate')));
const original=session.fromPartition.bind(session);
app.commandLine.appendSwitch('host-resolver-rules','MAP p83.weibiye.test 127.0.0.1');
app.commandLine.appendSwitch('no-proxy-server');
session.fromPartition=(...args)=>{
  const target=original(...args);
  target.setCertificateVerifyProc((request,callback)=>{
    try {
      const leaf=new X509Certificate(request.certificate.data);
      const valid=request.hostname==='p83.weibiye.test' && leaf.fingerprint256===certificate.fingerprint256
        && leaf.checkHost('p83.weibiye.test')==='p83.weibiye.test' && leaf.verify(certificate.publicKey)
        && Date.parse(leaf.validFrom)<=Date.now() && Date.parse(leaf.validTo)>=Date.now();
      callback(valid?0:-2);
    } catch {callback(-2);}
  });
  return target;
};
module.exports=require(path.join(root,'src/main.cjs'));
