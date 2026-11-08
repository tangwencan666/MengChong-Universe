'use strict';

require('./launch-env.cjs').stripModelEnvironment(process.env);

const path = require('node:path');
const fs = require('node:fs');
const electron = require('electron');
const { createGateway } = require('./gateway.cjs');
const { createManager } = require('./manager.cjs');
const { parseLocalCharacter } = require('./local-character.cjs');
const { createPositionStore } = require('./position-store.cjs');
const { createDiagnostics } = require('./diagnostics.cjs');
const { APP_ID, profileDirectory } = require('./app-profile.cjs');
const { productName, brandWindow } = require('./brand.cjs');
const { loadServiceProfile } = require('./service-profile.cjs');
const { createSupport } = require('./support-window.cjs');
const { createPowerRecovery } = require('./power-recovery.cjs');

let runtime;
let gateway;
let support;
let powerRecovery;
let quitting = false;
let quitReady = false;

function argument(name, fallback) {
  const inline = process.argv.find((value) => value.startsWith(`--${name}=`));
  if (inline) return inline.slice(name.length + 3);
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 && process.argv[at + 1] ? process.argv[at + 1] : fallback;
}

const rootDir = path.resolve(__dirname, '..');
const version = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8')).version;
const profile = profileDirectory({ explicit: argument('profile-dir'), packaged: electron.app.isPackaged,
  appData: electron.app.getPath('appData'), rootDir });
fs.mkdirSync(profile, { recursive: true });
electron.app.setPath('userData', profile);
electron.app.setName(productName);
electron.app.on('browser-window-created', (_event, window) => brandWindow(window));
const diagnostics = createDiagnostics({ directory: profile,
  version,
  enabled: process.argv.includes('--local-diagnostics') });

if (!electron.app.requestSingleInstanceLock()) {
  electron.app.quit();
} else {
  electron.app.on('second-instance', () => runtime?.showMain());
  electron.app.on('window-all-closed', () => {});
  electron.app.on('before-quit', (event) => {
    if (quitReady) return;
    event.preventDefault();
    if (quitting) return;
    quitting = true;
    void Promise.resolve().then(async () => {
      try { powerRecovery?.stop(); support?.stop(); await runtime?.stop(); } finally { await gateway?.close(); }
      diagnostics.write('stopped', { role: 'host' });
    }).catch(() => {
      diagnostics.write('cleanup_failed', { role: 'host' });
      console.error('桌面预览退出时遇到资源清理异常，请保留验收日志。');
    }).finally(() => { quitReady = true; electron.app.quit(); });
  });
  void electron.app.whenReady().then(async () => {
    if (process.platform === 'win32') electron.app.setAppUserModelId(APP_ID);
    if (['ignore-certificate-errors','disable-web-security','allow-running-insecure-content'].some(flag => electron.app.commandLine.hasSwitch(flag))) throw new Error('Insecure browser switches are not allowed');
    support = createSupport({electron,version});
    diagnostics.write('started', { role: 'host' });
    electron.app.on('child-process-gone', (_event, details) => diagnostics.write('child_gone', { role: 'host',
      reason: ['clean-exit', 'abnormal-exit', 'killed', 'crashed', 'oom', 'launch-failed', 'integrity-failure'].includes(details.reason) ? details.reason : 'unknown' }));
    const localCharacter = parseLocalCharacter(process.argv);
    const serviceProfile = loadServiceProfile(rootDir);
    const uiPort = Number(argument('ui-port', '35316'));
    if (!Number.isInteger(uiPort) || uiPort < 1024 || uiPort > 65535) throw new Error('Invalid local preview port');
    gateway = await createGateway({ uiPort,
      backendOrigin: argument('backend-origin', 'http://127.0.0.1:38316'),
      uiDir: path.join(rootDir, 'ui-dist'), petDir: path.join(rootDir, 'renderer'),
      assetDir: path.join(rootDir, 'assets'), rootDir, localCharacter,
      apiEnabled: serviceProfile.mode === 'local' });
    runtime = createManager({ electron, origin: serviceProfile.origin ?? gateway.origin,
      assetOrigin: gateway.origin, serviceProfile, rootDir, localCharacter,
      positionStore: createPositionStore(profile), diagnostics, onSupport: () => support.show() });
    powerRecovery = createPowerRecovery({ powerMonitor: electron.powerMonitor,
      recover: () => runtime.recover(), failed: () => diagnostics.write('resume_failed', {role:'host'}) });
    Object.defineProperty(runtime, 'assetStats', { get: () => gateway?.assetStats });
    await runtime.start();
  }).catch(() => {
    diagnostics.write('startup_failed', { role: 'host' });
    // Never log cookies, API bodies, credentials or user chat content.
    console.error('萌宠溜达桌面预览无法启动，请检查本机服务、资源和端口。');
    if (runtime && support) {
      runtime.mainWindow?.destroy();
      support.show();
    } else {
      electron.dialog.showErrorBox('萌宠溜达暂时无法启动', '请检查服务配置、资源和端口，然后重试。');
      electron.app.quit();
    }
  });
}

// Main-process-only acceptance inspection; never bridged to renderer IPC.
module.exports = { getRuntime: () => runtime };
