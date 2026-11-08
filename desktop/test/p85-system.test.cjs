'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createLayoutStore } = require('../src/p85-layout-store.cjs');
const { createResourceMonitor, HIGH_KIB, LOW_KIB, MAX_WINDOWS } = require('../src/p85-resources.cjs');
const { createCoordinator } = require('../src/pet-coordinator.cjs');
const actions = require('../src/pet-actions.cjs');
const OWNER = '10000000-0000-4000-8000-000000000001', OTHER = '10000000-0000-4000-8000-000000000002';
const ids = Array.from({ length: 6 }, (_, i) => `85000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`);
const selected = ids.slice(0, 5).map((pet_id, i) => ({ pet_id, hidden: i === 1 }));
test('layout persists instance IDs and hidden state, separately by owner; five is a storage bound', t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'p85-layout-'));
    t.after(() => { assert.equal(path.dirname(directory), os.tmpdir()); fs.rmSync(directory, { recursive: true }); });
    const store = createLayoutStore(directory);
    store.set(OWNER, { current: selected, previous: selected });
    assert.equal(store.flush(), true);
    assert.deepEqual(createLayoutStore(directory).get(OWNER), { current: selected, previous: selected });
    assert.deepEqual(store.get(OTHER), { current: [], previous: [] });
    assert.throws(() => store.set(OWNER, { current: [...selected, { pet_id: ids[5], hidden: false }] }));
    assert.throws(() => store.set(OWNER, { current: [selected[0], selected[0]] }));
    assert.throws(() => store.set(OWNER, { current: [{ ...selected[0], chat_body: 'must not persist' }] }));
});
test('malformed existing combination files are retained and never overwritten', t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'p85-bad-layout-'));
    t.after(() => { assert.equal(path.dirname(directory), os.tmpdir()); fs.rmSync(directory, { recursive: true }); });
    const file = path.join(directory, 'pet-layout-v1.json');
    fs.writeFileSync(file, 'original unknown data');
    const store = createLayoutStore(directory);
    assert.equal(store.healthy, false);
    assert.equal(store.set(OWNER, { current: selected }), false);
    store.flush();
    assert.equal(fs.readFileSync(file, 'utf8'), 'original unknown data');
});
function metric(privateBytes) { return [{ pid: 5, type: 'Browser', memory: { privateBytes, workingSetSize: privateBytes + 100 }, cpu: { percentCPUUsage: .1 } }]; }
test('resource readings share one bounded CPU clock and apply hysteresis without endless retention', () => {
    let now = 0, value = HIGH_KIB - 1, reads = 0;
    const monitor = createResourceMonitor(() => { reads++; return metric(value); }, () => now);
    monitor.sample();
    assert.equal(monitor.state.reduced_motion, false);
    monitor.sample();
    assert.equal(reads, 1);
    now = 5000;
    value = HIGH_KIB;
    monitor.sample();
    assert.equal(monitor.state.reduced_motion, true);
    now += 5000;
    value = LOW_KIB;
    monitor.sample();
    assert.equal(monitor.state.reduced_motion, true);
    now += 5000;
    value = LOW_KIB - 1;
    monitor.sample();
    assert.equal(monitor.state.reduced_motion, false);
    for (let i = 0; i < 30; i++) {
        now += 5000;
        monitor.sample();
    }
    assert.equal(monitor.samples.length, 8);
    assert.equal(monitor.mayAllocate(MAX_WINDOWS), false);
    assert.equal(monitor.mayAllocate(MAX_WINDOWS - 1), true);
    monitor.close();
    assert.equal(monitor.samples.length, 0);
});
test('unavailable private memory metrics are explicit and still retain the hard window bound', () => {
    const monitor = createResourceMonitor(() => undefined, () => 0);
    monitor.sample();
    assert.equal(monitor.state.metrics_available, false);
    assert.equal(monitor.mayAllocate(MAX_WINDOWS), false);
});
test('resource reduction pauses local behavior without changing preferences or AI/drag priority', () => {
    const actor = actions.createActor('hajimi', 0, { random: () => 0, preferences: { random: true, autoMove: true } });
    assert.equal(actions.tick(actor, 100000, { canMove: true, reducedMotion: true }).action, 'idle');
    assert.deepEqual(actor.preferences, { random: true, autoMove: true });
    assert.equal(actions.tick(actor, 100010, { activity: 'thinking', reducedMotion: true }).action, 'thinking');
    assert.equal(actions.tick(actor, 100020, { dragging: true, reducedMotion: true }).action, 'dragging');
    actions.tick(actor, 100030);
    assert.equal(actions.tick(actor, 200000, { canMove: true }).action, 'blink');
});
test('five same-species instances rotate distinct pairs without crossing owner/display/priority', () => {
    const pets = ids.slice(0, 5).map((id, i) => ({ id, owner: OWNER, definition: 'hajimi', display: 'screen', visible: true, random: true, autoMove: false, priority: 0, x: i * 100, y: 20 }));
    const coordinator = createCoordinator(), seen = new Set();
    for (let i = 0; i < 10; i++) {
        const plan = coordinator.plan(pets, i * 90000);
        assert.equal(plan.length, 2);
        assert.notEqual(plan[0].id, plan[1].id);
        plan.forEach(p => seen.add(p.id));
    }
    assert.equal(seen.size, 5);
    for (const change of [{ owner: OTHER }, { display: 'other' }, { priority: 95 }, { visible: false }, { random: false }]) {
        coordinator.clear();
        assert.deepEqual(coordinator.plan([pets[0], { ...pets[1], ...change }], 0), []);
    }
    coordinator.clear();
    assert.equal(coordinator.plan([pets[0], { ...pets[1], definition: 'maodie' }], 0).length, 2);
});
