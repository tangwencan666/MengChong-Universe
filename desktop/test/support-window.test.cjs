'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');
const {createSupport}=require('../src/support-window.cjs');

test('offline support reuses one window and exposes no scripts, preload, IPC or private context',()=>{
  const partition=new EventEmitter();let request,options,url,created=0;
  Object.assign(partition,{setPermissionRequestHandler(){},setPermissionCheckHandler(){},webRequest:{onBeforeRequest(callback){request=callback;}}});
  class Window extends EventEmitter {
    constructor(value){super();created++;options=value;this.webContents=new EventEmitter();this.webContents.setWindowOpenHandler=()=>{};}
    isDestroyed(){return Boolean(this.destroyed);}show(){}focus(){}destroy(){this.destroyed=true;}
    async loadURL(value){url=value;this.emit('ready-to-show');}
  }
  const helper=createSupport({electron:{BrowserWindow:Window,session:{fromPartition:()=>partition}},version:'0.1.0'});
  const first=helper.show();assert.equal(helper.show(),first);assert.equal(created,1);
  assert.equal(options.webPreferences.javascript,false);assert.equal(options.webPreferences.nodeIntegration,false);assert.equal(options.webPreferences.preload,undefined);
  request({url:'https://outside.example'},v=>assert.equal(v.cancel,true));
  assert.match(Buffer.from(url.split(',')[1],'base64').toString(),/最小离线反馈单/);
  helper.stop();assert.equal(first.isDestroyed(),true);
});
