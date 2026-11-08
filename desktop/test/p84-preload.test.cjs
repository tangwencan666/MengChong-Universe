'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), vm = require('node:vm'), fs = require('node:fs'), path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../src/preload.cjs'), 'utf8');
function harness() {
    let bridge, release;
    const calls = [], contextBridge = { exposeInMainWorld(_name, value) { bridge = value; } }, ipcRenderer = {
        invoke: async (name) => {
            calls.push(name);
            if (name === 'weibiye:pet:dragEnd')
                return new Promise(resolve => { release = resolve; });
            return { ok: true, value: null };
        }, on() { }, removeListener() { },
    };
    vm.runInNewContext(source, { require: () => ({ contextBridge, ipcRenderer }), process: { argv: ['--weibiye-role=pet'] } });
    return { bridge, calls, finish: value => release(value) };
}
test('a tap waits for its drag-end acknowledgement before chat or menu can run', async () => {
    const { bridge, calls, finish } = harness();
    await bridge.dragStart({ x: 50, y: 50 });
    const end = bridge.dragEnd(), chat = bridge.chat(), menu = bridge.menu();
    await new Promise(setImmediate);
    assert.deepEqual(calls, ['weibiye:pet:dragStart', 'weibiye:pet:dragEnd']);
    finish({ ok: true, value: null });
    await Promise.all([end, chat, menu]);
    assert.deepEqual(calls, ['weibiye:pet:dragStart', 'weibiye:pet:dragEnd', 'weibiye:pet:chat', 'weibiye:pet:menu']);
});
test('failed drag authorization cannot dispatch a queued chat or menu', async () => {
    const { bridge, calls, finish } = harness();
    await bridge.dragStart({ x: 50, y: 50 });
    const operations = [bridge.dragEnd(), bridge.chat(), bridge.menu()];
    const completed = Promise.allSettled(operations);
    await new Promise(setImmediate);
    finish({ ok: false, error: { code: 'SESSION_CHANGED', message: 'synthetic failure' } });
    assert.ok((await completed).every(value => value.status === 'rejected'));
    assert.deepEqual(calls, ['weibiye:pet:dragStart', 'weibiye:pet:dragEnd']);
});
