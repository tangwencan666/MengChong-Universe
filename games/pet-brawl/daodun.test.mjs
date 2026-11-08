import test from 'node:test';
import assert from 'node:assert/strict';
import { ARENA, ROSTER, DAODUN_SKILL, createMatch, step, drainEvents } from './engine.mjs';

function advance(m, seconds, input = {}, cpu = {}) { for (let i = 0; i < Math.ceil(seconds * 120); i++) step(m, input, 1 / 120, cpu); return m; }
function playing(x = 500, otherX = 650) { const m = createMatch('daodun', 'niwa'); advance(m, 2.3); drainEvents(m); m.fighters[0].x = x; m.fighters[1].x = otherX; return m; }
function cast(m) { step(m, {skill: true}, 1 / 120, {}); return m; }

test('shield charge telegraphs, then moves faster than a normal walk', () => {
  const m = cast(playing(200, 1000)), f = m.fighters[0]; advance(m, .1);
  assert.equal(f.x, 200); assert.equal(f.move.phase, 'windup'); assert.equal(m.stats.playerHits, 0);
  advance(m, .15); assert.equal(f.move.phase, 'rush'); assert.ok(f.x > 265); assert.equal(f.vx, DAODUN_SKILL.speed);
});
test('one collision stops the charge, knocks back, then a single broad cleave deals 6 + 14', () => {
  const m = cast(playing()), [f, other] = m.fighters; advance(m, .3);
  assert.equal(other.hp, ROSTER.niwa.health - 6); assert.equal(f.move.rushStopped, true); assert.equal(f.vx, 0); assert.ok(other.x > 650);
  const stoppedX = f.x; advance(m, .9); const hits = drainEvents(m).filter(e => e.type === 'hit');
  assert.deepEqual(hits.map(e => [e.skillPhase, e.damage]), [['rush', 6], ['cleave', 14]]);
  assert.equal(other.hp, ROSTER.niwa.health - 20); assert.ok(other.x > 820); assert.equal(f.x, stoppedX); assert.equal(m.stats.playerHits, 2);
});
test('a charge that misses still cleaves, reaching much farther than body contact', () => {
  const m = cast(playing(300, 760)); advance(m, 1.3);
  assert.deepEqual(drainEvents(m).filter(e => e.type === 'hit').map(e => [e.skillPhase, e.damage]), [['cleave', 14]]);
  assert.equal(m.fighters[1].hp, ROSTER.niwa.health - 14);
});
test('neither charge nor cleave can damage an opponent beyond the combined reach', () => {
  const m = cast(playing(100, 1100)); advance(m, 1.4);
  assert.equal(m.fighters[1].hp, ROSTER.niwa.health); assert.equal(m.stats.playerHits, 0);
  assert.equal(drainEvents(m).filter(e => e.type === 'cleave').length, 1);
});
test('locked charge and forward cleave cannot attack behind the caster', () => {
  const m = cast(playing()); m.fighters[1].x = 300; advance(m, 1.3);
  assert.equal(m.stats.playerHits, 0); assert.ok(m.fighters[0].x > 700);
});
test('left-facing charge and cleave have the same damage and knockback direction', () => {
  const m = cast(playing(800, 650)); advance(m, 1.3);
  assert.equal(m.fighters[1].hp, ROSTER.niwa.health - 20); assert.ok(m.fighters[1].x < 480); assert.ok(m.fighters[0].x < 800);
});
test('front guard applies once to each phase, retaining two total chip damage', () => {
  const m = playing(); step(m, {skill: true}, 1 / 120, {guard: true}); advance(m, 1.3, {}, {guard: true});
  const blocks = drainEvents(m).filter(e => e.type === 'block');
  assert.deepEqual(blocks.map(e => e.damage), [0, 2]); assert.equal(m.fighters[1].hp, ROSTER.niwa.health - 2); assert.equal(m.stats.playerHits, 0);
});
test('dodging the collision does not transfer its damage to the cleave', () => {
  const m = playing(); m.fighters[1].invulnerable = .5; cast(m); advance(m, 1.3);
  assert.equal(m.stats.dodges, 1); assert.equal(m.fighters[1].hp, ROSTER.niwa.health - 14);
});
test('pausing during rush freezes positions and emits only one cleave after resume', () => {
  const m = cast(playing(300, 760)); advance(m, .25); m.paused = true;
  const frozen = JSON.stringify(m.fighters); advance(m, 2); assert.equal(JSON.stringify(m.fighters), frozen);
  m.paused = false; advance(m, 1.3); assert.equal(drainEvents(m).filter(e => e.type === 'cleave').length, 1);
  assert.equal(m.fighters[1].hp, ROSTER.niwa.health - 14);
});
test('cast cost and cooldown are unchanged and holding U cannot stack charge hits', () => {
  const m = cast(playing()); assert.equal(m.fighters[0].stamina, 72); assert.equal(m.fighters[0].skillCooldown, 5.5);
  advance(m, 2.2, {skill: true}); const events = drainEvents(m);
  assert.equal(events.filter(e => e.type === 'attack' && e.kind === 'skill').length, 1);
  assert.equal(events.filter(e => e.type === 'cleave').length, 1); assert.equal(m.stats.playerHits, 2);
});
test('collision knockout finishes immediately without a later cleave', () => {
  const m = playing(); m.fighters[1].hp = 6; cast(m); advance(m, 2);
  assert.equal(m.phase, 'finished'); assert.equal(m.fighters[0].move, null);
  assert.equal(drainEvents(m).filter(e => e.type === 'cleave').length, 0); assert.equal(m.stats.playerHits, 1);
});
test('a rear hit during windup interrupts the charge and cancels its pending cleave', () => {
  const m = cast(playing()); m.fighters[1].x = 390; step(m, {}, 1 / 120, {light: true}); advance(m, 1.3);
  assert.equal(m.fighters[0].hp, ROSTER.daodun.health - 7); assert.equal(m.fighters[0].move, null);
  assert.equal(drainEvents(m).filter(e => e.type === 'cleave').length, 0);
});
test('arena edge stops movement and restart has no pending charge or cleave', () => {
  const m = cast(playing(1090, 1110)); advance(m, 1.4);
  assert.ok(m.fighters.every(f => f.x >= ARENA.left && f.x <= ARENA.right));
  const fresh = createMatch('daodun', 'niwa'); advance(fresh, 4);
  assert.equal(fresh.fighters[0].move, null); assert.equal(fresh.fighters[0].hp, 125);
  assert.equal(drainEvents(fresh).filter(e => e.type === 'cleave').length, 0);
});
