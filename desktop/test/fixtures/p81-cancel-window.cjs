'use strict';

// Offline test window only. It never loads the product or a remote model URL.
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const argument = prefix => process.argv.find(value => value.startsWith(prefix))?.slice(prefix.length);
const url = argument('--p81-fixture-url='), profile = argument('--p81-fixture-profile=');
if (!url || !/^http:\/\/127\.0\.0\.1:\d+\/pets\//.test(url) || !profile || !path.isAbsolute(profile)) {
  app.exit(2);
} else {
  app.setPath('userData', profile);
  app.disableHardwareAcceleration();
  app.whenReady().then(async () => {
    const window = new BrowserWindow({ show: false,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } });
    await window.loadURL(url);
  });
  app.on('window-all-closed', () => app.quit());
}
