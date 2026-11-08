'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const layout = require('../src/display-layout.cjs');
const motion = require('../src/motion.cjs');
const { createPositionStore, MAX_BYTES } = require('../src/position-store.cjs');
const activity = require('../src/pet-activity.cjs');

const id = (n) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const displays = [
  { id: 1, scaleFactor: 1.5, workArea: { x: 0, y: 0, width: 1536, height: 824 } },
  { id: 2, scaleFactor: 1, workArea: { x: -1920, y: 120, width: 1920, height: 1040 } },
];
const areas = layout.areas(displays);
const placement = { x: -1100, y: 400, displayId: '2', workArea: displays[1].workArea };
function profile(t) {
  const tempRoot = fs.realpathSync(os.tmpdir());
  const dir = fs.mkdtempSync(path.join(tempRoot, 'weibiye-p82-'));
  t.after(() => {
    assert.ok(fs.realpathSync(dir).startsWith(path.join(tempRoot, 'weibiye-p82-')));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}
function signal(n, state = 'running', sequence = 2, has_output = false) {
  return { generation_id: id(n), session_id: id(10), state, sequence, has_output };
}

test('DIP position survives restart and belongs only to its owner and pet', (t) => {
  const dir = profile(t);
  const one = createPositionStore(dir);
  one.set(id(1), id(2), placement); assert.equal(one.flush(), true);
  const restored = createPositionStore(dir);
  assert.deepEqual(restored.get(id(1), id(2)), placement);
  assert.equal(restored.get(id(3), id(2)), null);
  assert.equal(restored.get(id(1), id(3)), null);
  const bytes = fs.readFileSync(path.join(dir, 'pet-positions-v1.json'), 'utf8');
  assert.equal(bytes.includes(id(1)), false); assert.equal(bytes.includes(id(2)), false);
  assert.equal(restored.flush(), true);
  assert.deepEqual(fs.readdirSync(dir), ['pet-positions-v1.json']);
});

for (const malformed of ['not JSON', JSON.stringify({ version: 2, positions: {} }), 'x'.repeat(MAX_BYTES + 1)]) {
  test('invalid/oversized position file is preserved and cannot break startup: ' + malformed.length, (t) => {
    const dir = profile(t), file = path.join(dir, 'pet-positions-v1.json');
    fs.writeFileSync(file, malformed);
    const store = createPositionStore(dir);
    assert.equal(store.healthy, false); assert.equal(store.get(id(1), id(2)), null);
    assert.equal(store.set(id(1), id(2), placement), false); assert.equal(store.flush(), false);
    assert.equal(fs.readFileSync(file, 'utf8'), malformed);
  });
}

test('storage remains bounded without retaining chat, identity or arbitrary paths', (t) => {
  const dir = profile(t), store = createPositionStore(dir);
  for (let n = 1; n <= 140; n++) store.set(id(1), id(n), placement);
  assert.equal(store.flush(), true); assert.equal(store.get(id(1), id(1)), null);
  assert.deepEqual(store.get(id(1), id(140)), placement);
  assert.throws(() => store.set(id(1), '../../elsewhere', placement));
  assert.throws(() => store.set(id(1), id(2), { ...placement, content: 'private' }));
  assert.throws(() => store.set(id(1), id(2), { ...placement, x: Infinity }));
});

test('negative secondary monitor coordinates are restored without multiplying DPI', () => {
  assert.deepEqual(layout.restore(placement, areas, 188, 196), { x: -1100, y: 400 });
  assert.deepEqual(layout.capture(placement, areas, 188, 196), placement);
});

test('monitor removal and separated displays cannot strand a window in the gap', () => {
  assert.deepEqual(layout.restore(placement, areas.slice(0, 1), 188, 196), { x: 0, y: 400 });
  const separated = layout.areas([displays[1], { id: 3, workArea: { x: 1000, y: -1000, width: 1000, height: 700 } }]);
  const restored = layout.restore({ ...placement, displayId: 'removed', x: 500, y: 0 }, separated, 188, 196);
  assert.ok(separated.some((a) => restored.x >= a.x && restored.x + 188 <= a.x + a.width
    && restored.y >= a.y && restored.y + 196 <= a.y + a.height));
});

test('DPI or work-area changes preserve relative position within the same display', () => {
  const old = { x: 674, y: 314, displayId: '1', workArea: displays[0].workArea };
  const changed = layout.areas([{ id: 1, scaleFactor: 2, workArea: { x: 0, y: 0, width: 1200, height: 700 } }]);
  assert.deepEqual(layout.restore(old, changed, 188, 196), { x: 506, y: 252 });
  assert.throws(() => layout.areas([{ id: 1, workArea: { x: 0, y: 0, width: 50, height: 50 } }]));
});

test('native world supports dragging onto a second display and safely removing it', () => {
  const world = motion.createWorld({ bounds: displays[0].workArea, displays, autonomous: false, now: 0 });
  motion.spawnPet(world, 'one'); motion.spawnPet(world, 'two');
  motion.beginDrag(world, 'one'); motion.moveDrag(world, 'one', { x: -1000, y: 400 }); motion.endDrag(world, 'one');
  assert.equal(motion.snapshot(world, 'one').x, -1000);
  motion.setDisplays(world, [displays[0]]);
  for (const p of motion.snapshot(world)) assert.ok(p.x >= 0 && p.x + 188 <= 1536);
  assert.equal(motion.overlaps(...motion.snapshot(world)), false);
  const before = motion.snapshot(world);
  motion.tickWorld(world, 100000);
  assert.deepEqual(motion.snapshot(world).map(({ x, y }) => ({ x, y })), before.map(({ x, y }) => ({ x, y })));
});

test('generation metadata drives four states without copying conversation data', () => {
  const one = activity.createActivity(0), sibling = activity.createActivity(0);
  assert.equal(activity.view(one, 0).activity, 'idle');
  activity.greet(one, 'cat', 0); assert.equal(activity.view(one, 0).activity, 'happy');
  activity.applySignal(one, signal(1), 1); assert.equal(activity.view(one, 1).activity, 'thinking');
  activity.applySignal(one, signal(1, 'running', 3, true), 2); assert.equal(activity.view(one, 2).activity, 'speaking');
  assert.equal(activity.greet(one, 'cat', 3), false);
  activity.applySignal(one, signal(1, 'completed', 4, true), 4); assert.equal(activity.view(one, 4).activity, 'happy');
  assert.equal(activity.view(one, 2505).activity, 'idle');
  assert.equal(activity.view(sibling, 2505).activity, 'idle');
  assert.equal(JSON.stringify(one).includes('content'), false);
});

test('terminal, retired-generation and out-of-order signals cannot revive old output', () => {
  const value = activity.createActivity(0);
  activity.applySignal(value, signal(1, 'running', 3, true), 1);
  assert.equal(activity.applySignal(value, signal(1, 'running', 2), 2), false);
  activity.applySignal(value, signal(1, 'cancelled', 4), 3);
  assert.equal(activity.applySignal(value, signal(1, 'completed', 5, true), 4), false);
  activity.applySignal(value, signal(2), 5);
  assert.equal(activity.applySignal(value, signal(1, 'running', 6, true), 6), false);
  assert.equal(activity.view(value, 6).activity, 'thinking');
  assert.throws(() => activity.applySignal(value, { ...signal(2), content: 'private' }, 7));
  assert.throws(() => activity.applySignal(value, signal(2, 'arbitrary-command'), 7));
});
