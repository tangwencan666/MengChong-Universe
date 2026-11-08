import test from 'node:test';
import assert from 'node:assert/strict';
import { ARENA, ROSTER, WHALE_SKILL, createMatch, step, drainEvents, seededRandom } from './engine.mjs';

function advance(match, seconds, input = {}, cpu = {}) { for (let i = 0; i < Math.ceil(seconds * 120); i++) step(match, input, 1 / 120, cpu); return match; }
function playing(a = 'niwa', b = 'daodun') { const m = createMatch(a, b); advance(m, 2.3); drainEvents(m); assert.equal(m.phase, 'playing'); return m; }
function close(m) { m.fighters[0].x = 500; m.fighters[1].x = 610; return m; }

test('roster contains exactly the three supplied characters and rejects unknown IDs', () => {
  assert.deepEqual(Object.keys(ROSTER), ['niwa', 'daodun', 'whale']);
  assert.throws(() => createMatch('moon', 'whale'));
  assert.throws(() => createMatch('niwa', 'doubao'));
});
test('countdown cannot damage either fighter or consume match time', () => {
  const m = createMatch(); advance(m, 1, { heavy: true }, { skill: true });
  assert.equal(m.timeLeft, 90); assert.equal(m.stats.playerHits, 0); assert.equal(m.phase, 'countdown');
});
test('movement, boundaries and jump landing are physically bounded', () => {
  const m = playing(); const f = m.fighters[0];
  advance(m, .4, { right: true }); assert.ok(f.x > 430);
  advance(m, 5, { left: true }); assert.equal(f.x, ARENA.left);
  advance(m, .15, { jump: true }); assert.ok(f.y > 30); assert.equal(f.grounded, false);
  advance(m, 1.4); assert.equal(f.y, 0); assert.equal(f.grounded, true);
});

for (const id of Object.keys(ROSTER)) test(`${id} jumps visibly higher, stays inside the stage and lands once without an air jump`, () => {
  const m = playing(id, 'daodun'), f = m.fighters[0], events = [];
  step(m, { jump: true }, 1 / 120, {}); let peak = f.y; events.push(...drainEvents(m));
  for (let i = 0; i < 180; i++) {
    step(m, { jump: i < 72 }, 1 / 120, {}); peak = Math.max(peak, f.y); events.push(...drainEvents(m));
  }
  assert.ok(peak > 320 && peak < 370, `apex ${peak} should be clearly above the previous 202–222 range`);
  assert.equal(events.filter(e => e.type === 'jump' && e.side === 0).length, 1);
  assert.equal(events.filter(e => e.type === 'land' && e.side === 0).length, 1);
  assert.equal(f.y, 0); assert.equal(f.vy, 0); assert.equal(f.grounded, true);
});
test('overlapping fighters separate without leaving the arena', () => {
  const m = playing(); m.fighters[0].x = 80; m.fighters[1].x = 80;
  advance(m, .4); assert.ok(m.fighters.every(f => f.x >= ARENA.left && f.x <= ARENA.right));
  assert.ok(Math.abs(m.fighters[0].x - m.fighters[1].x) > 92);
});
test('light attack hits once per swing, produces feedback and knockback', () => {
  const m = close(playing()); const before = m.fighters[1].hp;
  step(m, { light: true }, 1 / 120, {}); advance(m, .32);
  assert.equal(before - m.fighters[1].hp, 7); assert.equal(m.stats.playerHits, 1);
  assert.ok(m.fighters[1].x > 610); assert.equal(drainEvents(m).filter(e => e.type === 'hit').length, 1);
});
test('out-of-range attacks do not cause damage', () => {
  const m = playing(); advance(m, 1, { heavy: true }); assert.equal(m.fighters[1].hp, ROSTER.daodun.health);
});
test('locked attack direction cannot hit someone behind the attacker', () => {
  const m = close(playing()); step(m, { heavy: true }, 1 / 120, {});
  m.fighters[1].x = 390; advance(m, .5); assert.equal(m.stats.playerHits, 0);
});
test('heavy attack telegraphs before dealing larger damage', () => {
  const m = close(playing()); step(m, { heavy: true }, 1 / 120, {}); advance(m, .15);
  assert.equal(m.fighters[1].hp, ROSTER.daodun.health);
  advance(m, .2); assert.equal(m.fighters[1].hp, ROSTER.daodun.health - 18);
});
test('front guard reduces damage and spends the defender stamina', () => {
  const m = close(playing()); advance(m, .2, { light: true }, { guard: true });
  assert.equal(m.fighters[1].hp, ROSTER.daodun.health - 2); assert.ok(m.fighters[1].stamina < 90); assert.equal(m.stats.blocks, 1);
});
test('guard cannot block a projectile from the rear', () => {
  const m = playing('whale', 'daodun'); m.fighters[0].x = 350; m.fighters[1].x = 950;
  advance(m, .72, { skill: true }, { guard: true }); m.fighters[0].x = 1050;
  advance(m, 1.2, {}, { guard: true }); assert.equal(m.fighters[1].hp, ROSTER.daodun.health - 16); assert.equal(m.stats.blocks, 0);
});
test('airborne input does not establish a grounded guard', () => {
  const m = playing(); advance(m, .1, {}, { jump: true }); step(m, {}, 1 / 120, { guard: true }); assert.equal(m.fighters[1].guard, false);
});
test('dash has a brief invulnerability window, cost and cooldown', () => {
  const m = playing(); step(m, { dash: true }, 1 / 120, {}); const f = m.fighters[0];
  assert.equal(f.action, 'dash'); assert.ok(f.invulnerable > 0); assert.ok(f.stamina < 80); assert.ok(f.dashCooldown > .7);
  advance(m, .3, { dash: true }); assert.equal(f.invulnerable, 0); assert.ok(f.dashCooldown > 0);
});
test('insufficient stamina rejects heavy attacks and skills', () => {
  const m = close(playing()); m.fighters[0].stamina = 0; step(m, { skill: true }, 1 / 120, {});
  assert.equal(m.fighters[0].move, null); assert.equal(m.fighters[0].skillCooldown, 0);
});
test('holding a skill does not bypass its cooldown', () => {
  const m = playing(); advance(m, 2, { skill: true }); assert.equal(drainEvents(m).filter(e => e.type === 'attack' && e.kind === 'skill').length, 1); assert.ok(m.fighters[0].skillCooldown > 3);
});
test('whale three stars travel, hit once each and total the original 16 damage', () => {
  const m = playing('whale', 'daodun'); advance(m, .35, { skill: true }); assert.equal(m.projectiles.length, 1);
  advance(m, 1.8); assert.equal(m.stats.playerHits, 3); assert.equal(m.projectiles.length, 0);
  assert.equal(m.fighters[1].hp, ROSTER.daodun.health - 16);
  assert.deepEqual(drainEvents(m).filter(e => e.type === 'hit').map(e => e.damage), [5, 5, 6]);
});
test('jump avoids the first low travelling star', () => {
  const m = playing('whale', 'daodun'); m.fighters[1].x = 680;
  advance(m, .35, { skill: true }); advance(m, .3, {}, { jump: true });
  assert.equal(m.stats.playerHits, 0); assert.equal(m.fighters[1].hp, ROSTER.daodun.health);
});
test('whale burst budgets retain 16 damage, 2 chip and 16 guard cost', () => {
  assert.deepEqual(WHALE_SKILL.map(shot => shot.damage), [5, 5, 6]);
  for (const [key, total] of [['damage', 16], ['chipDamage', 2], ['guardCost', 16]]) assert.equal(WHALE_SKILL.reduce((n, shot) => n + shot[key], 0), total);
});
test('one whale cast costs 28 stamina, keeps 5.5s cooldown, and cannot emit a fourth star', () => {
  const m = playing('whale', 'daodun'); step(m, { skill: true }, 1 / 120, {});
  assert.equal(m.fighters[0].stamina, 72); assert.equal(m.fighters[0].skillCooldown, 5.5);
  advance(m, 3, { skill: true }); const events = drainEvents(m);
  assert.deepEqual(events.filter(e => e.type === 'star').map(e => e.stage), [1, 2, 3]);
  assert.equal(events.filter(e => e.type === 'attack').length, 1); assert.equal(m.stats.playerHits, 3);
});
test('guarding all three whale stars still takes only two chip damage', () => {
  const m = close(playing('whale', 'daodun')); advance(m, 2, { skill: true }, { guard: true });
  assert.equal(m.fighters[1].hp, ROSTER.daodun.health - 2); assert.equal(m.stats.blocks, 3);
  assert.deepEqual(drainEvents(m).filter(e => e.type === 'block').map(e => e.damage), [0, 1, 1]);
});
test('dodging the first whale star does not transfer its five damage into later hits', () => {
  const m = close(playing('whale', 'daodun')); m.fighters[1].invulnerable = .4;
  advance(m, 2, { skill: true }); assert.equal(m.stats.dodges, 1); assert.equal(m.stats.playerHits, 2);
  assert.equal(m.fighters[1].hp, ROSTER.daodun.health - 11);
});
test('pausing between whale shots resumes remaining stages exactly once', () => {
  const m = playing('whale', 'daodun'); advance(m, .35, { skill: true }); assert.equal(m.fighters[0].move.nextShot, 1);
  m.paused = true; const before = JSON.stringify({ move: m.fighters[0].move, projectiles: m.projectiles }); advance(m, 2);
  assert.equal(JSON.stringify({ move: m.fighters[0].move, projectiles: m.projectiles }), before);
  m.paused = false; advance(m, 2); assert.deepEqual(drainEvents(m).filter(e => e.type === 'star').map(e => e.stage), [1, 2, 3]);
  assert.equal(m.fighters[1].hp, ROSTER.daodun.health - 16);
});
test('knockout on the first whale star stops all remaining cast stages', () => {
  const m = close(playing('whale', 'daodun')); m.fighters[1].hp = 5; advance(m, 2, { skill: true });
  assert.equal(m.phase, 'finished'); assert.equal(m.stats.playerHits, 1); assert.equal(m.projectiles.length, 0);
  assert.deepEqual(drainEvents(m).filter(e => e.type === 'star').map(e => e.stage), [1]);
});
test('whale light and heavy attacks retain their previous damage', () => {
  const light = close(playing('whale', 'daodun')); step(light, { light: true }, 1 / 120, {}); advance(light, .3);
  assert.equal(light.fighters[1].hp, ROSTER.daodun.health - 7);
  const heavy = close(playing('whale', 'daodun')); step(heavy, { heavy: true }, 1 / 120, {}); advance(heavy, .5);
  assert.equal(heavy.fighters[1].hp, ROSTER.daodun.health - 18);
});
test('niwa laughter can hit a nearby opponent on either side, one point at a time', () => {
  const m = close(playing()); step(m, { skill: true }, 1 / 120, {}); m.fighters[1].x = 370;
  advance(m, 3); assert.equal(m.stats.playerHits, 21); assert.equal(m.fighters[1].hp, ROSTER.daodun.health - 21);
});
test('three chained light attacks reach the third-hit combo', () => {
  const m = playing(); m.fighters[1].x = 1100;
  advance(m, 1, { light: true }); const attacks = drainEvents(m).filter(e => e.type === 'attack'); assert.ok(attacks.length >= 3); assert.equal(m.fighters[0].combo, 3);
});
test('knockout terminates once and no later input changes health', () => {
  const m = close(playing()); m.fighters[1].hp = 7; advance(m, .3, { light: true });
  assert.equal(m.phase, 'finished'); assert.equal(m.winner, 0); const hp = m.fighters[0].hp;
  advance(m, 5, {}, { heavy: true }); assert.equal(m.fighters[0].hp, hp); assert.equal(drainEvents(m).filter(e => e.type === 'finish').length, 1);
});
test('simultaneous knockout is a draw, not a first-update advantage', () => {
  const m = close(playing()); m.fighters.forEach(f => { f.hp = 7; }); advance(m, .3, { light: true }, { light: true });
  assert.equal(m.phase, 'finished'); assert.equal(m.winner, 'draw');
});
test('timeout compares health ratios across different max-health characters', () => {
  const m = playing(); m.fighters[0].hp = 55; m.fighters[1].hp = 75; m.timeLeft = .001;
  step(m, {}, 1 / 120, {}); assert.equal(m.reason, 'time'); assert.equal(m.winner, 1);
});
test('pause freezes countdown, cooldowns, positions and match timer', () => {
  const m = close(playing()); step(m, { skill: true }, 1 / 120, {}); m.paused = true;
  const before = JSON.stringify({ f: m.fighters, t: m.timeLeft, p: m.projectiles }); advance(m, 4, { right: true, heavy: true });
  assert.equal(JSON.stringify({ f: m.fighters, t: m.timeLeft, p: m.projectiles }), before);
});
test('restart creates fresh health, resources, projectiles and match statistics', () => {
  const m = close(playing()); advance(m, 1, { skill: true }); const fresh = createMatch(m.fighters[0].id, m.fighters[1].id);
  assert.equal(fresh.fighters[0].hp, 110); assert.equal(fresh.fighters[0].stamina, 100); assert.equal(fresh.fighters[0].skillCooldown, 0); assert.equal(fresh.projectiles.length, 0); assert.equal(fresh.stats.playerHits, 0); assert.equal(fresh.timeLeft, 90);
});
test('seeded AI is reproducible and actually attacks a stationary player', () => {
  const run = () => { const m = createMatch('niwa', 'daodun', { seed: 122 }); advance(m, 2.3); for (let i = 0; i < 2000; i++) step(m, {}); return m; };
  const a = run(), b = run(); assert.deepEqual(a.fighters, b.fighters); assert.ok(a.stats.cpuHits > 0); assert.ok(a.fighters[0].hp < 110);
});
test('simulation rejects unbounded or invalid time steps and bounds feedback queues', () => {
  const m = playing(); for (const dt of [0, -1, 1, NaN, Infinity]) assert.throws(() => step(m, {}, dt));
  advance(m, 12, { light: true }); assert.ok(m.events.length <= 32); assert.ok(m.projectiles.length <= 6);
  const r1 = seededRandom(42), r2 = seededRandom(42); assert.deepEqual(Array.from({ length: 10 }, r1), Array.from({ length: 10 }, r2));
});
