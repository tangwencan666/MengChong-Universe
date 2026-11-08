'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { registry, createRegistry } = require('../src/pet-registry.cjs');
const actions = require('../src/pet-actions.cjs');
const { createCoordinator, interactionStep } = require('../src/pet-coordinator.cjs');
const { createPreferences } = require('../src/pet-preferences.cjs');
const { registerPetAssets } = require('../src/pet-asset-cache.cjs');
const manifest = require('../assets/pet-definitions.json');
const motion = require('../src/motion.cjs');
const OWNER = '10000000-0000-4000-8000-000000000001', PET = '20000000-0000-4000-8000-000000000001';
test('one registry preserves the original five and defines eight independent personas', () => {
    assert.deepEqual(registry.list().map(p => p.name), ['月芽', '豆包', '小云', '耄耋', '哈吉米', '奶娃', '刀盾', '鲸鱼娘']);
    assert.equal(new Set(registry.list().map(p => p.persona)).size, 8);
    assert.equal(registry.resolve('maodie', 'cat').id, 'maodie');
    assert.equal(registry.resolve('../../else', 'cat').id, 'moon');
    for (const change of [value => value.pets.push(value.pets[0]), value => value.pets[0].assets.idle = 'https://outside/a.svg',
        value => value.pets[0].random = ['javascript'], value => value.actions.jump.duration = Infinity,
        value => value.actions.blink.priority = 110, value => delete value.actions.dragging]) {
        const copy = structuredClone(manifest);
        change(copy);
        assert.throws(() => createRegistry(copy));
    }
});
test('drag, hide and AI preempt lower actions; expired actions converge without a queue', () => {
    const actor = actions.createActor('maodie', 0, { random: () => .5 });
    assert.equal(actions.start(actor, 'jump', 100), true);
    assert.equal(actions.tick(actor, 150, { activity: 'thinking' }).action, 'thinking');
    assert.equal(actions.start(actor, 'roll', 200), false);
    assert.equal(actions.tick(actor, 250, { dragging: true, activity: 'speaking' }).action, 'dragging');
    assert.equal(actions.tick(actor, 300, { hidden: true, dragging: true }).action, 'hidden');
    assert.equal(actions.tick(actor, 400, { activity: 'speaking' }).action, 'speaking');
    assert.equal(actions.tick(actor, 450).action, 'idle');
    assert.equal(actions.start(actor, 'jump', 1000, { direct: true }), true);
    const seq = actor.sequence;
    assert.equal(actions.start(actor, 'jump', 1010), false);
    assert.equal(actor.sequence, seq);
    assert.equal(actions.tick(actor, 2100).action, 'idle');
    assert.equal(actor.sequence, seq + 1);
    assert.equal(actions.tick(actor, 50).action, 'idle');
});
test('random cooldowns and disabled preferences prevent continuous idle work and movement', () => {
    const actor = actions.createActor('hajimi', 0, { random: () => 0 });
    assert.equal(actions.tick(actor, 30000).action, 'blink');
    actions.tick(actor, 30300);
    const sequence = actor.sequence;
    for (let time = 30300; time < 65000; time += 50)
        actions.tick(actor, time);
    assert.equal(actor.sequence, sequence);
    actions.configure(actor, { random: false, autoMove: false });
    for (let time = 100000; time < 1000000; time += 1000)
        assert.equal(actions.tick(actor, time, { near: true, canMove: true }).action, 'idle');
    assert.throws(() => actions.configure(actor, { autoMove: 'yes' }));
    assert.throws(() => actions.configure(actor, { url: 'outside' }));
});
test('one actor never changes sibling state and user requests remain bounded', () => {
    const one = actions.createActor('maodie', 0), two = actions.createActor('hajimi', 0);
    assert.equal(actions.start(one, 'innocent', 0, { direct: true }), true);
    assert.equal(actions.start(one, 'jump', 100, { direct: true }), false);
    assert.equal(actions.tick(two, 100).action, 'idle');
    actions.dispose(one);
    assert.equal(actions.start(one, 'jump', 1000), false);
    assert.equal(one.cooldowns.size, 0);
});
test('safe sleep preference restores but temporary chat and drag state do not persist', () => {
    const actor = actions.createActor('hajimi', 0);
    actions.start(actor, 'sleep', 0, { direct: true });
    const saved = actions.saved(actor);
    assert.equal(saved.sleeping, true);
    assert.equal(actions.createActor('hajimi', 5000, { preferences: saved }).action, 'sleep');
    actions.tick(actor, 100, { activity: 'thinking' });
    assert.equal(actions.saved(actor).sleeping, false);
    assert.equal(actions.createActor('hajimi', 5000, { preferences: actions.saved(actor) }).action, 'idle');
});
test('coordinator uses same owner/display only, honors priority and applies a ninety-second cooldown', () => {
    const pair = [{ id: 'one', owner: 'a', definition: 'maodie', display: '1', visible: true, random: true, autoMove: true, priority: 0, x: 0, y: 0 },
        { id: 'two', owner: 'a', definition: 'hajimi', display: '1', visible: true, random: true, autoMove: true, priority: 0, x: 300, y: 0 }];
    const coordinator = createCoordinator();
    assert.deepEqual(coordinator.plan(pair, 0).map(p => p.action), ['follow', 'evade']);
    assert.deepEqual(coordinator.plan(pair, 1), []);
    for (const changes of [{ owner: 'b' }, { display: '2' }, { priority: 80 }, { visible: false }, { random: false }]) {
        coordinator.clear();
        assert.deepEqual(coordinator.plan([pair[0], { ...pair[1], ...changes }], 100000), []);
    }
});
test('bounded movement never crosses monitor gaps, overlap or drag ownership', () => {
    const world = motion.createWorld({ bounds: { x: 0, y: 0, width: 1600, height: 900 }, autonomous: false, random: () => .5, now: 0 });
    motion.spawnPet(world, 'one', { x: 30, y: 200 });
    motion.spawnPet(world, 'two', { x: 350, y: 200 });
    assert.equal(motion.moveTo(world, 'one', { x: 400, y: 200 }), false);
    assert.equal(motion.moveTo(world, 'one', { x: 100, y: 200 }), true);
    motion.beginDrag(world, 'one');
    assert.equal(motion.moveTo(world, 'one', { x: 150, y: 200 }), false);
    motion.disposeWorld(world);
});
test('coordinated approach and avoidance step toward the other pet, independently of the cursor', () => {
    const self = { x: 200, y: 100 }, other = { x: 600, y: 100 };
    assert.deepEqual(interactionStep('follow', self, other), { x: 270, y: 100 });
    assert.deepEqual(interactionStep('evade', other, self), { x: 660, y: 100 });
    assert.equal(interactionStep('look', self, other), null);
    assert.equal(interactionStep('follow', self, self), null);
    assert.equal(interactionStep('follow', self, { x: Infinity, y: 100 }), null);
    const copy = structuredClone(manifest);
    copy.pets[3].id = 'future-cat';
    copy.pets[3].movement = 'walk';
    copy.pets[3].menu = ['stretch'];
    assert.deepEqual(createRegistry(copy).get('future-cat').menu, ['stretch']);
});
test('preferences are scoped by account and pet; malformed files are preserved', async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'p84-prefs-'));
    t.after(async () => { assert.equal(path.dirname(directory), os.tmpdir()); await fs.rm(directory, { recursive: true }); });
    const store = createPreferences(directory), value = { random: false, autoMove: true, sleeping: true };
    store.set(OWNER, PET, value);
    assert.equal(store.flush(), true);
    assert.deepEqual(createPreferences(directory).get(OWNER, PET), value);
    assert.deepEqual(store.get(PET, PET), {});
    await fs.writeFile(path.join(directory, 'pet-behavior-v1.json'), 'original unknown data');
    const damaged = createPreferences(directory);
    assert.equal(damaged.healthy, false);
    assert.equal(damaged.set(OWNER, PET, value), false);
    assert.equal(await fs.readFile(path.join(directory, 'pet-behavior-v1.json'), 'utf8'), 'original unknown data');
});
test('pet images load on demand, deduplicate concurrent reads and release their bounded cache', async () => {
    const resources = new Map();
    const cache = await registerPetAssets(path.join(__dirname, '../assets'), resources, { budget: 5000 });
    assert.equal(cache.stats.bytes, 0);
    assert.equal(cache.stats.loads, 0);
    const resource = resources.get('/__assets/p84-maodie.svg');
    const [first, second] = await Promise.all([resource.read(), resource.read()]);
    assert.equal(first, second);
    assert.equal(cache.stats.loads, 1);
    for (const resource of resources.values())
        await resource.read();
    assert.ok(cache.stats.bytes <= 5000);
    assert.ok(cache.stats.entries < resources.size);
    cache.close();
    assert.equal(cache.stats.bytes, 0);
    await assert.rejects(resource.read());
});
