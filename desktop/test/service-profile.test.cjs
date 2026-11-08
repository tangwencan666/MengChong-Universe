'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateServiceProfile } = require('../src/service-profile.cjs');
const hosted = origin => ({schema:'weibiye-service/1',mode:'hosted',origin});

test('remote access is off in the shipped profile and hosted origins require HTTPS DNS', () => {
  assert.equal(validateServiceProfile(require('../service-profile.json')).mode, 'local');
  assert.equal(validateServiceProfile(hosted('https://beta.weibiye.test:4433')).origin, 'https://beta.weibiye.test:4433');
  for (const endpoint of ['http://beta.example.com', 'https://127.0.0.1', 'https://localhost', 'https://beta.example.com/path', 'https://u:p@beta.example.com', 'https://beta.example.com?key=private', 'https://beta.example.com#token']) {
    assert.throws(() => validateServiceProfile(hosted(endpoint)));
  }
});

test('unknown secret-bearing service fields are refused before reading values', () => {
  const input = hosted('https://beta.example.com');
  Object.defineProperty(input, 'apiKey', {enumerable:true,get(){assert.fail('Sensitive getter read');}});
  assert.throws(() => validateServiceProfile(input), /Invalid service profile/);
});
