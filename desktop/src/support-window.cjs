'use strict';
const { randomUUID } = require('node:crypto');

function createSupport({ electron, version }) {
  if (!/^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/.test(version)) throw new Error('Invalid support version');
  let window;
  const partition = electron.session.fromPartition('weibiye-help-' + randomUUID(), {cache:false});
  partition.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  partition.setPermissionCheckHandler(() => false);
  partition.webRequest.onBeforeRequest((details, callback) => callback({cancel:!details.url.startsWith('data:')}));
  partition.on('will-download', event => event.preventDefault());
  return {
    show() {
      if (window && !window.isDestroyed()) { window.show(); window.focus(); return window; }
      const feedback = JSON.stringify({schema:'weibiye-feedback/1',category:'connection',report_id:randomUUID(),created_at:new Date().toISOString(),app_version:version},null,2);
      const html = '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; form-action \'none\'; base-uri \'none\'"><title>未毕业 · 连接帮助与反馈</title><style>body{font:16px/1.7 system-ui;background:#faf8f3;color:#253b31;padding:28px}textarea{box-sizing:border-box;width:100%;height:200px;background:white;border:1px solid #acb9aa;padding:12px}h1{font-size:24px}</style><h1>连接帮助与反馈</h1><p>请检查网络并稍后重试。可从托盘打开主界面；退出应用也可通过托盘完成。</p><p>下方内容只含版本、随机编号、时间及固定问题类别。请选中复制给邀请人；不会自动上传，也不包含聊天、账号、设备标识或密钥。</p><textarea readonly aria-label="最小离线反馈单">' + feedback.replaceAll('&','&amp;').replaceAll('<','&lt;') + '</textarea><p>本地诊断默认关闭。真实模型回复、服务域名和内测额度以当前获准环境为准；本程序不会要求填写模型 API Key。</p></html>';
      window = new electron.BrowserWindow({title:'未毕业 · 连接帮助与反馈',width:660,height:610,show:false,
        webPreferences:{session:partition,sandbox:true,contextIsolation:true,nodeIntegration:false,javascript:false,webSecurity:true,backgroundThrottling:true}});
      const created = window;
      created.setMenu?.(null);
      created.webContents.setWindowOpenHandler(() => ({action:'deny'}));
      created.webContents.on('will-navigate', event => event.preventDefault());
      created.once('ready-to-show',()=>{if(!created.isDestroyed())created.show();});
      void created.loadURL('data:text/html;base64,'+Buffer.from(html).toString('base64')).catch(()=>{if(!created.isDestroyed())created.destroy();});
      return created;
    },
    stop() { if(window && !window.isDestroyed())window.destroy(); },
  };
}
module.exports={createSupport};
