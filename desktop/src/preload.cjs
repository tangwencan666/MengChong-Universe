'use strict';

// The sandboxed preload exposes explicit actions, never ipcRenderer, event objects,
// credentials, file paths, arbitrary URLs or executable scripts.
const { contextBridge, ipcRenderer } = require('electron');
const role = process.argv.includes('--weibiye-role=pet') ? 'pet' : 'ui';

async function invoke(method, ...args) {
  const result = await ipcRenderer.invoke(`weibiye:${method}`, ...args);
  if (!result?.ok) {
    const error = new Error(result?.error?.message ?? '暂时无法完成桌面操作。');
    error.code = result?.error?.code ?? 'UNAVAILABLE';
    throw error;
  }
  return result.value;
}

function subscribe(channel, callback) {
  if (typeof callback !== 'function') throw new TypeError('需要提供状态接收函数。');
  const listener = (_event, value) => callback(value);
  ipcRenderer.on(channel, listener);
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    ipcRenderer.removeListener(channel, listener);
  };
}

if (role === 'pet') {
  let dragReady = Promise.resolve();
  let dragFinished = Promise.resolve();
  contextBridge.exposeInMainWorld('weibiyePet', Object.freeze({
    identity: () => invoke('pet:identity'),
    dragStart: (point) => {
      dragReady = dragFinished.catch(() => {}).then(() => invoke('pet:dragStart', point));
      return dragReady;
    },
    dragMove: (point) => dragReady.then(() => invoke('pet:dragMove', point)),
    dragEnd: () => { dragFinished = dragReady.then(() => invoke('pet:dragEnd')); return dragFinished; },
    chat: () => dragFinished.then(() => invoke('pet:chat')),
    menu: () => dragFinished.then(() => invoke('pet:menu')),
    sharedEvents: () => invoke('pet:sharedEvents'),
    onState: (callback) => subscribe('weibiye:pet-state', callback),
  }));
} else {
  contextBridge.exposeInMainWorld('weibiyeDesktop', Object.freeze({
    version: 'desktop-pet/0.2',
    layout: () => invoke('desktop:layout'),
    recallAll: (expectedOwner) => invoke('desktop:recallAll', expectedOwner),
    restoreCombination: (expectedOwner) => invoke('desktop:restoreCombination', expectedOwner),
    activity: (id, signal) => invoke('desktop:activity', id, signal),
    list: () => invoke('desktop:list'),
    release: (id) => invoke('desktop:release', id),
    hide: (id) => invoke('desktop:hide', id),
    show: (id) => invoke('desktop:show', id),
    recall: (id) => invoke('desktop:recall', id),
    openChat: (id) => invoke('desktop:openChat', id),
    syncSession: () => invoke('desktop:syncSession'),
    society: owner => invoke('desktop:society', owner),
    socialAction: (owner,id,action,key,version) => invoke('desktop:socialAction',owner,id,action,key,version),
    socialSettings: (owner,patch) => invoke('desktop:socialSettings',owner,patch),
    deleteSocialEvent: (owner,id) => invoke('desktop:deleteSocialEvent',owner,id),
    onSociety: callback => subscribe('weibiye:society-state',callback),
    companionContext: (id,sessionId=null,mode='peek') => invoke('desktop:companionContext',id,sessionId,mode),
    onCompanionContext: callback => subscribe('weibiye:companion-context-changed',callback),
    onChange: (callback) => subscribe('weibiye:desktop-state', callback),
  }));
}
