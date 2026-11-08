'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeIcon } = require('../scripts/build-icon.cjs');
const { buildEnvironment } = require('../scripts/package-installer.cjs');
const config = require('../electron-builder.config.cjs');
const { APP_ID } = require('../src/app-profile.cjs');
test('installer icon contains independent PNG frames up to native 256px', () => {
  const ico = makeIcon(); assert.equal(ico.readUInt16LE(2), 1); assert.equal(ico.readUInt16LE(4), 7);
  for (let i = 0; i < 7; i++) {
    const at = 6 + i*16, width = ico[at] || 256, offset = ico.readUInt32LE(at+12), bytes = ico.readUInt32LE(at+8);
    assert.ok(offset + bytes <= ico.length); assert.equal(ico.toString('ascii', offset+12, offset+16), 'IHDR');
    assert.equal(ico.readUInt32BE(offset+16), width); assert.equal(ico.readUInt32BE(offset+20), width);
  }
});
test('build child cannot read model, signing or publication credentials', () => {
  const source = { PATH: 'local', SYSTEMROOT: 'Windows' };
  for (const name of ['DEEPSEEK_API_KEY','WEIBIYE_DEEPSEEK_API_KEY','OPENAI_API_KEY','GH_TOKEN','CSC_LINK','WIN_CSC_KEY_PASSWORD','AWS_SECRET_ACCESS_KEY']) {
    Object.defineProperty(source, name, { enumerable:true, get() { throw new Error('Credential read'); } });
  }
  const value = buildEnvironment(source);
  assert.deepEqual(value, {PATH:'local',SYSTEMROOT:'Windows',CSC_IDENTITY_AUTO_DISCOVERY:'false'});
});
test('local installer is per-user, never publishes, preserves app data and keeps signature verification on', () => {
  assert.equal(config.appId, APP_ID); assert.equal(config.publish, null);
  assert.equal(config.nsis.perMachine, false); assert.equal(config.nsis.allowElevation, false);
  assert.equal(config.nsis.deleteAppDataOnUninstall, false); assert.equal(config.nsis.runAfterFinish, false);
  assert.equal(config.win.verifyUpdateCodeSignature, true); assert.equal(config.win.requestedExecutionLevel, 'asInvoker');
});
