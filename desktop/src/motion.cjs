'use strict';

// Pure DIP geometry/state. The native host owns exactly one shared 50 ms timer.
const GAP = 12;
const STATES = new Set(['idle', 'walking', 'resting', 'dragging']);
const layout = require('./display-layout.cjs');

function number(value, label) {
  if (!Number.isFinite(value)) throw new TypeError(label + ' must be finite');
  return value;
}

function validBounds(bounds, width, height) {
  if (!bounds || typeof bounds !== 'object') throw new TypeError('bounds required');
  const result = {
    x: Math.round(number(bounds.x, 'bounds.x')),
    y: Math.round(number(bounds.y, 'bounds.y')),
    width: Math.floor(number(bounds.width, 'bounds.width')),
    height: Math.floor(number(bounds.height, 'bounds.height')),
  };
  if (result.width < width || result.height < height) {
    throw new RangeError('Work area is smaller than a pet window');
  }
  return result;
}

function active(world) {
  if (!world || world.disposed) throw new Error('Motion world is disposed');
}

function random(world) {
  const value = world.random();
  return Number.isFinite(value) ? Math.max(0, Math.min(0.999999, value)) : 0.5;
}

function delay(world, min, range) {
  return min + Math.floor(random(world) * range);
}

function createWorld(options) {
  const width = Math.floor(number(options?.width ?? 188, 'width'));
  const height = Math.floor(number(options?.height ?? 196, 'height'));
  if (width < 1 || height < 1) throw new RangeError('Positive pet dimensions required');
  return {
    bounds: validBounds(options?.bounds, width, height),
    displayAreas: layout.areas(options.displays ?? [{ id: 'primary', workArea: options.bounds }], width, height),
    autonomous: options.autonomous !== false,
    width,
    height,
    pets: new Map(),
    random: options.random ?? Math.random,
    now: number(options.now ?? Date.now(), 'now'),
    disposed: false,
  };
}

function clampPosition(world, point) {
  active(world);
  const { width, height } = world;
  const checked = { x: number(point.x, 'x'), y: number(point.y, 'y') };
  const bounds = layout.nearest(world.displayAreas, checked, width, height);
  return {
    x: Math.round(Math.max(bounds.x, Math.min(bounds.x + bounds.width - width, number(point.x, 'x')))),
    y: Math.round(Math.max(bounds.y, Math.min(bounds.y + bounds.height - height, number(point.y, 'y')))),
  };
}

function overlaps(a, b, gap = GAP) {
  return a.x < b.x + b.width + gap && a.x + a.width + gap > b.x
    && a.y < b.y + b.height + gap && a.y + a.height + gap > b.y;
}

function occupied(world, id, point) {
  const candidate = { ...point, width: world.width, height: world.height };
  return [...world.pets.values()].some((pet) => pet.pet_id !== id && pet.visible && overlaps(candidate, pet));
}

// Search only bounded local/native geometry, never a screen-sized pixel loop.
function findPosition(world, id, desired) {
  const origin = clampPosition(world, desired);
  if (!occupied(world, id, origin)) return origin;
  const { width, height } = world;
  const bounds = layout.nearest(world.displayAreas, origin, width, height);
  const xs = new Set([origin.x, bounds.x, bounds.x + bounds.width - width]);
  const ys = new Set([origin.y, bounds.y, bounds.y + bounds.height - height]);
  for (const pet of world.pets.values()) {
    if (pet.pet_id === id || !pet.visible) continue;
    xs.add(pet.x - width - GAP);
    xs.add(pet.x + width + GAP);
    ys.add(pet.y - height - GAP);
    ys.add(pet.y + height + GAP);
  }
  const candidates = [];
  const seen = new Set();
  for (const x of xs) for (const y of ys) {
    const point = clampPosition(world, { x, y });
    const key = point.x + ':' + point.y;
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push(point);
  }
  candidates.sort((a, b) => Math.hypot(a.x - origin.x, a.y - origin.y) - Math.hypot(b.x - origin.x, b.y - origin.y));
  return candidates.find((candidate) => !occupied(world, id, candidate)) ?? null;
}

function view(pet) {
  return {
    pet_id: pet.pet_id, x: pet.x, y: pet.y, width: pet.width, height: pet.height,
    state: pet.state, direction: pet.direction, visible: pet.visible,
  };
}

function getPet(world, id) {
  active(world);
  const pet = world.pets.get(id);
  if (!pet) throw new Error('Unknown pet');
  return pet;
}

function spawnPet(world, id, restored) {
  active(world);
  if (typeof id !== 'string' || !id || id.length > 100) throw new TypeError('Pet id required');
  if (world.pets.has(id)) throw new Error('Pet already spawned');
  const position = findPosition(world, id, restored ?? {
    x: world.bounds.x + 20 + world.pets.size * (world.width + GAP),
    y: world.bounds.y + world.bounds.height - world.height - 12,
  });
  if (!position) throw new RangeError('No non-overlapping work area available');
  const pet = {
    pet_id: id, ...position, width: world.width, height: world.height,
    state: 'idle', direction: 'right', visible: true,
    nextAt: world.now + delay(world, 1600, 2200), target: null,
    speed: 34 + random(world) * 18,
  };
  world.pets.set(id, pet);
  return view(pet);
}

function settle(world, pet, state = 'idle') {
  pet.state = state;
  pet.target = null;
  delete pet.motionX;
  delete pet.motionY;
  pet.nextAt = world.now + delay(world, state === 'resting' ? 3200 : 1800, 2800);
}

function startNextAction(world, pet) {
  if (random(world) > 0.72) {
    settle(world, pet, 'resting');
    return;
  }
  const bounds = layout.nearest(world.displayAreas, pet, world.width, world.height);
  const target = findPosition(world, pet.pet_id, {
    x: bounds.x + random(world) * (bounds.width - world.width),
    y: bounds.y + random(world) * (bounds.height - world.height),
  });
  if (!target || Math.hypot(target.x - pet.x, target.y - pet.y) < 16) {
    settle(world, pet);
    return;
  }
  pet.target = target;
  pet.motionX = pet.x;
  pet.motionY = pet.y;
  pet.direction = target.x < pet.x ? 'left' : 'right';
  pet.state = 'walking';
}

function tickWorld(world, now) {
  if (world?.disposed) return [];
  active(world);
  const time = number(now, 'now');
  const elapsed = Math.max(0, Math.min(100, time - world.now));
  world.now = Math.max(world.now, time);
  for (const pet of world.pets.values()) {
    if (!pet.visible || pet.state === 'dragging') continue;
    if (pet.state !== 'walking') {
      if (world.autonomous && world.now >= pet.nextAt) startNextAction(world, pet);
      continue;
    }
    const dx = pet.target.x - pet.x;
    const dy = pet.target.y - pet.y;
    const distance = Math.hypot(dx, dy);
    const step = pet.speed * elapsed / 1000;
    if (distance <= Math.max(1, step)) {
      if (!occupied(world, pet.pet_id, pet.target)) Object.assign(pet, pet.target);
      settle(world, pet);
      continue;
    }
    // Subpixel accumulators avoid rounding a slow 50ms step down to zero.
    const originX = pet.motionX ?? pet.x;
    const originY = pet.motionY ?? pet.y;
    const raw = { x: originX + dx / distance * step, y: originY + dy / distance * step };
    const candidate = clampPosition(world, raw);
    if (occupied(world, pet.pet_id, candidate)) {
      pet.motionX = pet.x;
      pet.motionY = pet.y;
      settle(world, pet);
      continue;
    }
    pet.motionX = raw.x;
    pet.motionY = raw.y;
    Object.assign(pet, candidate);
  }
  return snapshot(world);
}

function beginDrag(world, id, position) {
  const pet = getPet(world, id);
  if (!pet.visible) return view(pet);
  if (position) {
    const candidate = findPosition(world, id, position);
    if (candidate) Object.assign(pet, candidate);
  }
  pet.state = 'dragging';
  pet.target = null;
  delete pet.motionX;
  delete pet.motionY;
  return view(pet);
}

function moveDrag(world, id, position) {
  const pet = getPet(world, id);
  if (!pet.visible || pet.state !== 'dragging') return view(pet);
  const candidate = findPosition(world, id, position);
  if (candidate) Object.assign(pet, candidate);
  return view(pet);
}

function endDrag(world, id) {
  const pet = getPet(world, id);
  if (pet.state === 'dragging') settle(world, pet);
  return view(pet);
}

function setVisibility(world, id, visible) {
  const pet = getPet(world, id);
  if (typeof visible !== 'boolean') throw new TypeError('Visibility must be boolean');
  if (visible === pet.visible) return view(pet);
  if (visible) {
    const candidate = findPosition(world, id, pet);
    if (!candidate) throw new RangeError('No non-overlapping work area available');
    Object.assign(pet, candidate);
  }
  pet.visible = visible;
  delete pet.motionX;
  delete pet.motionY;
  settle(world, pet);
  return view(pet);
}

function removePet(world, id) {
  active(world);
  return world.pets.delete(id);
}

function setBounds(world, bounds) {
  active(world);
  const nextBounds = validBounds(bounds, world.width, world.height);
  // Build a new placement first so a monitor resize failure cannot partly mutate pets.
  const trial = { ...world, bounds: nextBounds, displayAreas: [{ id: 'primary', ...nextBounds }], pets: new Map() };
  for (const pet of world.pets.values()) {
    const candidate = pet.visible ? findPosition(trial, pet.pet_id, pet) : clampPosition(trial, pet);
    if (!candidate) throw new RangeError('Work area cannot fit the active pets');
    trial.pets.set(pet.pet_id, { ...pet, ...candidate, target: null, state: 'idle' });
  }
  world.bounds = nextBounds;
  world.displayAreas = trial.displayAreas;
  for (const [id, proposed] of trial.pets) {
    Object.assign(world.pets.get(id), proposed);
    delete world.pets.get(id).motionX;
    delete world.pets.get(id).motionY;
    settle(world, world.pets.get(id));
  }
  return snapshot(world);
}

function setDisplays(world, displays) {
  active(world);
  const next = layout.areas(displays, world.width, world.height);
  const trial = { ...world, displayAreas: next, pets: new Map() };
  for (const pet of world.pets.values()) {
    const saved = layout.capture(pet, world.displayAreas, world.width, world.height);
    const desired = layout.restore(saved, next, world.width, world.height);
    const candidate = pet.visible ? findPosition(trial, pet.pet_id, desired) : clampPosition(trial, desired);
    if (!candidate) throw new RangeError('Displays cannot fit active pets');
    trial.pets.set(pet.pet_id, { ...pet, ...candidate });
  }
  world.displayAreas = next;
  const { id: _id, ...bounds } = next[0];
  world.bounds = bounds;
  for (const [id, proposed] of trial.pets) {
    Object.assign(world.pets.get(id), proposed);
    settle(world, world.pets.get(id));
  }
  return snapshot(world);
}

function snapshot(world, id) {
  active(world);
  return id === undefined ? [...world.pets.values()].map(view) : view(getPet(world, id));
}

function disposeWorld(world) {
  if (!world || world.disposed) return;
  world.pets.clear();
  world.disposed = true;
}

function moveTo(world, id, desired, speed = 40) {
  const pet = getPet(world, id);
  if (!pet.visible || pet.state === 'dragging' || !Number.isFinite(speed) || speed < 10 || speed > 90) return false;
  const point = clampPosition(world, desired);
  // Small local steps only; never jump between disconnected work areas.
  const area = layout.nearest(world.displayAreas, pet, world.width, world.height);
  if (point.x < area.x || point.y < area.y || point.x + world.width > area.x + area.width
    || point.y + world.height > area.y + area.height || Math.hypot(point.x-pet.x,point.y-pet.y)>240
    || occupied(world,id,point) || Math.hypot(point.x-pet.x,point.y-pet.y)<8) return false;
  pet.target=point;pet.motionX=pet.x;pet.motionY=pet.y;pet.speed=speed;
  pet.direction=point.x<pet.x?'left':'right';pet.state='walking';return true;
}
function stopMotion(world,id) { const pet=getPet(world,id);if(pet.state==='walking')settle(world,pet); }

module.exports = {
  GAP, STATES, createWorld, spawnPet, tickWorld, beginDrag, moveDrag, endDrag,
  setVisibility, removePet, setBounds, setDisplays, snapshot, disposeWorld, clampPosition, overlaps, moveTo, stopMotion,
};
