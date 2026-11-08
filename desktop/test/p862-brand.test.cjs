'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{EventEmitter}=require('node:events');
const {brandWindow,productName}=require('../src/brand.cjs');
test('legacy support caption changes without rewriting a user conversation title and listeners are released',()=>{
  const win=new EventEmitter();let title='未毕业 · 连接帮助与反馈';win.getTitle=()=>title;win.setTitle=value=>{title=value};
  brandWindow(win);assert.equal(title,productName+' · 连接帮助与反馈');
  let prevented=0;win.emit('page-title-updated',{preventDefault(){prevented++}},'未毕业 · 连接帮助与反馈');assert.equal(prevented,1);
  win.emit('page-title-updated',{preventDefault(){prevented++}},'用户的话：WeiBiYe / 未毕业');assert.equal(prevented,1);
  win.emit('closed');assert.equal(win.listenerCount('page-title-updated'),0);
});
test('new display brand retains installation identity and existing profile directory',()=>{
  const config=require('../electron-builder.config.cjs'),{APP_ID,profileDirectory}=require('../src/app-profile.cjs'),path=require('node:path');
  assert.equal(productName,'萌宠溜达');assert.equal(config.productName,productName);assert.equal(config.nsis.shortcutName,productName);assert.equal(config.nsis.uninstallDisplayName,productName+'（内测版）');
  assert.equal(config.appId,APP_ID);assert.equal(APP_ID,'com.weibiye.desktop');assert.equal(config.win.requestedExecutionLevel,'asInvoker');assert.equal(config.nsis.deleteAppDataOnUninstall,false);assert.equal(config.publish,null);
  const data=path.resolve('existing-profile-root');assert.equal(profileDirectory({packaged:true,appData:data,rootDir:__dirname}),path.join(data,'WeiBiYe'));
});
