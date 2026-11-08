'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { closeWindowAndWait } = require('./window-close.cjs');

test('test driver waits for asynchronous native closed before reopening', async () => {
  const win = new EventEmitter(); let finish, completed = false;
  win.isDestroyed = () => false;
  win.close = () => { finish = () => win.emit('closed'); };
  const closing = closeWindowAndWait(win).then(() => { completed = true; });
  await Promise.resolve(); assert.equal(completed, false);
  finish(); await closing; assert.equal(completed, true); assert.equal(win.listenerCount('closed'), 0);
});

test('a vetoed close times out without forcing destruction or retaining listeners', async () => {
  const win = new EventEmitter(); win.isDestroyed = () => false; win.close = () => {};
  win.destroy = () => assert.fail('The test must respect a vetoed close');
  await assert.rejects(closeWindowAndWait(win, 10), /close did not complete/);
  assert.equal(win.listenerCount('closed'), 0);
});

test('already closed and failed closes leave no pending window listener', async () => {
  await closeWindowAndWait(null);
  await closeWindowAndWait({ isDestroyed: () => true });
  const win = new EventEmitter(); win.isDestroyed = () => false;
  win.close = () => { throw new Error('Synthetic close error'); };
  await assert.rejects(closeWindowAndWait(win), /Synthetic close error/);
  assert.equal(win.listenerCount('closed'), 0);
});
