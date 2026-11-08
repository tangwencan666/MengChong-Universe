'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const motion = require('../src/motion.cjs');

function sequence(values) {
  let index = 0;
  return () => values[index++ % values.length];
}

function world(options = {}) {
  return motion.createWorld({
    bounds: { x: 0, y: 0, width: 1280, height: 720 },
    width: 188, height: 196, now: 0,
    random: sequence([0.1, 0.6, 0.3, 0.9, 0.15, 0.7, 0.4]),
    ...options,
  });
}

function invariant(value) {
  const pets = motion.snapshot(value);
  for (const pet of pets) {
    assert.ok(pet.x >= value.bounds.x);
    assert.ok(pet.y >= value.bounds.y);
    assert.ok(pet.x + pet.width <= value.bounds.x + value.bounds.width);
    assert.ok(pet.y + pet.height <= value.bounds.y + value.bounds.height);
    assert.ok(motion.STATES.has(pet.state));
    for (const other of pets) {
      if (pet.pet_id !== other.pet_id && pet.visible && other.visible) {
        assert.equal(motion.overlaps(pet, other), false, pet.pet_id + ' overlapped ' + other.pet_id);
      }
    }
  }
}

test('three pets receive distinct bounded non-overlapping DIP positions', () => {
  const value = world();
  const positions = ['a', 'b', 'c'].map((id) => motion.spawnPet(value, id));
  assert.equal(new Set(positions.map((pet) => pet.x + ':' + pet.y)).size, 3);
  invariant(value);
});

test('negative monitor coordinates clamp to work area', () => {
  const value = world({ bounds: { x: -1920, y: -120, width: 1920, height: 1040 } });
  motion.spawnPet(value, 'a');
  motion.beginDrag(value, 'a');
  motion.moveDrag(value, 'a', { x: -1e6, y: 1e6 });
  assert.deepEqual(motion.snapshot(value, 'a'), {
    pet_id: 'a', x: -1920, y: 724, width: 188, height: 196,
    state: 'dragging', direction: 'right', visible: true,
  });
  invariant(value);
});

test('long deterministic run preserves bounds, independent states and no overlap', () => {
  const value = world();
  ['a', 'b', 'c'].forEach((id) => motion.spawnPet(value, id));
  const visited = new Map(['a', 'b', 'c'].map((id) => [id, new Set()]));
  const states = new Set();
  for (let now = 50; now <= 90000; now += 50) {
    const pets = motion.tickWorld(value, now);
    for (const pet of pets) {
      visited.get(pet.pet_id).add(pet.x + ':' + pet.y);
      states.add(pet.state);
    }
    invariant(value);
  }
  for (const positions of visited.values()) assert.ok(positions.size > 10);
  assert.ok(states.has('walking'));
  assert.ok(states.has('resting'));
  assert.ok(states.has('idle'));
});

test('dragging into another pet finds a safe nearby position without moving the other pet', () => {
  const value = world();
  motion.spawnPet(value, 'a');
  const b = motion.spawnPet(value, 'b');
  motion.beginDrag(value, 'a');
  motion.moveDrag(value, 'a', { x: b.x, y: b.y });
  assert.deepEqual(motion.snapshot(value, 'b'), b);
  assert.equal(motion.snapshot(value, 'a').state, 'dragging');
  invariant(value);
  const ended = motion.endDrag(value, 'a');
  assert.equal(ended.state, 'idle');
  invariant(value);
});

test('hidden pet freezes, showing resolves overlap and never catches up with elapsed time', () => {
  const value = world({ random: () => 0.4 });
  const a = motion.spawnPet(value, 'a');
  motion.spawnPet(value, 'b');
  motion.setVisibility(value, 'a', false);
  for (let now = 50; now <= 10000; now += 50) motion.tickWorld(value, now);
  const hidden = motion.snapshot(value, 'a');
  assert.equal(hidden.x, a.x);
  assert.equal(hidden.y, a.y);
  assert.equal(hidden.visible, false);
  motion.beginDrag(value, 'b');
  motion.moveDrag(value, 'b', a);
  motion.endDrag(value, 'b');
  motion.setVisibility(value, 'a', true);
  const shown = motion.snapshot(value, 'a');
  motion.tickWorld(value, 10050);
  assert.equal(motion.snapshot(value, 'a').x, shown.x);
  assert.equal(motion.snapshot(value, 'a').y, shown.y);
  invariant(value);
});

test('monitor resize reflows pets atomically and validates capacity', () => {
  const value = world();
  ['a', 'b', 'c'].forEach((id) => motion.spawnPet(value, id));
  motion.setBounds(value, { x: -700, y: 100, width: 700, height: 500 });
  invariant(value);
  const before = motion.snapshot(value);
  const bounds = { ...value.bounds };
  assert.throws(() => motion.setBounds(value, { x: 0, y: 0, width: 188, height: 196 }), /fit/);
  assert.deepEqual(motion.snapshot(value), before);
  assert.deepEqual(value.bounds, bounds);
});

test('lifecycle removes pets, returns immutable snapshots and disposes without timers', () => {
  const value = world();
  motion.spawnPet(value, 'a');
  const copy = motion.snapshot(value, 'a');
  copy.x = 999999;
  assert.notEqual(motion.snapshot(value, 'a').x, copy.x);
  assert.equal(motion.removePet(value, 'a'), true);
  assert.equal(motion.removePet(value, 'a'), false);
  motion.spawnPet(value, 'b');
  motion.disposeWorld(value);
  motion.disposeWorld(value);
  assert.equal(value.pets.size, 0);
  assert.deepEqual(motion.tickWorld(value, 100), []);
  assert.throws(() => motion.spawnPet(value, 'c'), /disposed/);
});

test('clock sleep is bounded and malformed coordinates never enter native geometry', () => {
  const value = world({ random: () => 0.4 });
  motion.spawnPet(value, 'a');
  motion.tickWorld(value, 10000);
  const before = motion.snapshot(value, 'a');
  assert.equal(before.state, 'walking');
  motion.tickWorld(value, 1000000);
  const after = motion.snapshot(value, 'a');
  assert.ok(Math.hypot(after.x - before.x, after.y - before.y) <= 7);
  motion.beginDrag(value, 'a');
  assert.throws(() => motion.moveDrag(value, 'a', { x: NaN, y: 0 }), /finite/);
  assert.throws(() => motion.moveDrag(value, 'a', { x: 0, y: Infinity }), /finite/);
  invariant(value);
});

test('duplicate ids and work area capacity cannot create overlapping windows', () => {
  const value = world({ bounds: { x: 0, y: 0, width: 188, height: 196 } });
  motion.spawnPet(value, 'a');
  assert.throws(() => motion.spawnPet(value, 'a'), /already/);
  assert.throws(() => motion.spawnPet(value, 'b'), /non-overlapping/);
  assert.equal(motion.snapshot(value).length, 1);
  invariant(value);
});

