'use strict';

require('node:test')('installed startup strips model names without reading their values', () => {
  const assert = require('node:assert/strict');
  const { stripModelEnvironment } = require('../src/launch-env.cjs');
  const environment = { PATH: 'local', NORMAL: 'kept' };
  for (const name of ['DEEPSEEK_API_KEY', 'weibiye_deepseek_api_key', 'OpenAI_API_KEY']) {
    Object.defineProperty(environment, name, { configurable: true, enumerable: true, get() { throw new Error('Credential value read'); } });
  }
  stripModelEnvironment(environment);
  assert.deepEqual(environment, { PATH: 'local', NORMAL: 'kept' });
});

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { desktopEnvironment } = require('../src/launch-env.cjs');

test('desktop environment strips server/model names case-insensitively without mutation', () => {
  const source = Object.freeze({
    PATH: 'C:\\fixture\\bin',
    SystemRoot: 'C:\\fixture\\Windows',
    TEMP: 'C:\\fixture\\temp',
    USERPROFILE: 'C:\\fixture\\user',
    unrelated: 'preserved',
    WEIBIYE_DEEPSEEK_API_KEY: 'synthetic-secret',
    weibiye_DATABASE_URL: 'synthetic-private-dsn',
    OpenAI_API_Key: 'synthetic-openai-secret',
    deepseek_api_key: 'synthetic-deepseek-secret',
    DEEPSEEK_BASE_URL: 'synthetic-server-config',
    electron_RUN_as_NODE: '1',
  });
  const result = desktopEnvironment(source);
  assert.deepEqual(result, {
    PATH: 'C:\\fixture\\bin',
    SystemRoot: 'C:\\fixture\\Windows',
    TEMP: 'C:\\fixture\\temp',
    USERPROFILE: 'C:\\fixture\\user',
    unrelated: 'preserved',
  });
  assert.notEqual(result, source);
  assert.equal(source.WEIBIYE_DEEPSEEK_API_KEY, 'synthetic-secret');
  result.PATH = 'changed copy';
  assert.equal(source.PATH, 'C:\\fixture\\bin');
});

test('filtered values are never read and only own environment entries are copied', () => {
  const source = Object.create({ inherited: 'must not copy' });
  for (const name of ['WEIBIYE_KEY', 'OPENAI_KEY', 'DEEPSEEK_KEY', 'ELECTRON_RUN_AS_NODE']) {
    Object.defineProperty(source, name, {
      enumerable: true,
      get() { throw new Error('Filtered values must never be accessed'); },
    });
  }
  source.Path = 'fixture-path';
  assert.deepEqual(desktopEnvironment(source), { Path: 'fixture-path' });
});

test('actual launcher passes only filtered environment and retains launch arguments', () => {
  const launchPath = path.resolve(__dirname, '../scripts/launch.cjs');
  const source = fs.readFileSync(launchPath, 'utf8');
  const calls = [];
  const handlers = {};
  const syntheticProcess = {
    env: Object.freeze({
      PATH: 'fixture-path',
      SystemRoot: 'fixture-windows',
      WEIBIYE_DEEPSEEK_API_KEY: 'synthetic-key-only',
      OPENAI_API_KEY: 'synthetic-key-only',
      deepseek_API_KEY: 'synthetic-key-only',
      ELECTRON_RUN_AS_NODE: '1',
    }),
    argv: ['fixture-node', launchPath, '--backend=http://127.0.0.1:38318', '--ui-port=35318'],
    exitCode: undefined,
  };
  vm.runInNewContext(source, {
    __dirname: path.dirname(launchPath),
    process: syntheticProcess,
    console: { error() {} },
    require(name) {
      if (name === 'node:fs') return { existsSync: () => true };
      if (name === 'node:path') return path;
      if (name === '../src/launch-env.cjs') return { desktopEnvironment };
      if (name === 'node:child_process') return {
        spawn(executable, args, options) {
          calls.push({ executable, args, options });
          return { on(event, handler) { handlers[event] = handler; } };
        },
      };
      throw new Error('Unexpected launcher import');
    },
  }, { filename: launchPath });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].executable, path.resolve(__dirname, '../node_modules/electron/dist/electron.exe'));
  assert.deepEqual(Array.from(calls[0].args), [
    path.resolve(__dirname, '..'), '--backend=http://127.0.0.1:38318', '--ui-port=35318',
  ]);
  assert.equal(calls[0].options.stdio, 'inherit');
  assert.deepEqual(calls[0].options.env, { PATH: 'fixture-path', SystemRoot: 'fixture-windows' });
  assert.equal(syntheticProcess.env.WEIBIYE_DEEPSEEK_API_KEY, 'synthetic-key-only');
  handlers.exit(0);
  assert.equal(syntheticProcess.exitCode, 0);
  handlers.error(new Error('synthetic startup failure'));
  assert.equal(syntheticProcess.exitCode, 1);
});
