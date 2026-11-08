// Pure local simulation. No DOM, network, account, pet-store, or model dependency.
export const ARENA = Object.freeze({ width: 1200, height: 640, floor: 505, left: 76, right: 1124 });
export const ROSTER = Object.freeze({
  niwa: Object.freeze({ id: 'niwa', name: '奶娃', subtitle: '捧腹声波手', color: '#f6b733', health: 110, speed: 315, jump: 1080, width: 112, height: 180, asset: './assets/niwa.png', skill: '捧腹大笑', description: '捧腹大笑释放周围声波，每次1点并短暂僵直，21次全中合计21。' }),
  daodun: Object.freeze({ id: 'daodun', name: '刀盾', subtitle: '稳稳的守卫', color: '#db8a54', health: 125, speed: 255, jump: 1040, width: 176, height: 142, asset: './assets/daodun.png', skill: '冲锋横斩', description: '举盾冲刺，撞到对手便击退，再向前大范围挥砍；6＋14，全中20。' }),
  whale: Object.freeze({ id: 'whale', name: '鲸鱼娘', subtitle: '蓝色潮汐使者', color: '#6c86ef', health: 100, speed: 295, jump: 1060, width: 143, height: 177, asset: './assets/whale.png', skill: '三连星弹', description: '抱手蓄力后伸掌连发三颗星弹，5＋5＋6，总伤害16。' }),
});
// One cast, three independently avoidable projectiles. Full-hit and full-guard
// totals retain the old single wave's 16 damage / 2 chip / 16 guard stamina.
export const WHALE_SKILL = Object.freeze([
  Object.freeze({ at: 0.25, damage: 5, chipDamage: 0, guardCost: 5 }),
  Object.freeze({ at: 0.46, damage: 5, chipDamage: 1, guardCost: 5 }),
  Object.freeze({ at: 0.67, damage: 6, chipDamage: 1, guardCost: 6 }),
]);
export const DAODUN_SKILL = Object.freeze({ rushStart: .16, rushEnd: .50, speed: 820, contactRange: 108, collisionDamage: 6, slashAt: .54, slashActive: .20, slashRange: 310, slashDamage: 14, duration: .98 });
export const NIWA_SKILL = Object.freeze({ windup: .28, interval: .10, count: 21, range: 205, stun: .13, duration: 2.6 });
const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
const blankInput = () => ({ left: false, right: false, jump: false, light: false, heavy: false, skill: false, guard: false, dash: false });
export function seededRandom(seed) {
  let n = seed >>> 0;
  return () => { n += 0x6D2B79F5; let t = n; t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}
function fighter(id, side) {
  const spec = ROSTER[id];
  if (!spec) throw new TypeError('Unknown fighter');
  return { id, side, x: side === 0 ? 335 : 865, y: 0, vx: 0, vy: 0, facing: side === 0 ? 1 : -1, hp: spec.health, stamina: 100, grounded: true, action: 'idle', move: null, stun: 0, controlled: 0, invulnerable: 0, flash: 0, attackCooldown: 0, skillCooldown: 0, dashCooldown: 0, combo: 0, comboWindow: 0, comboHits: 0, hitWindow: 0, guard: false, damage: 0 };
}
export function createMatch(playerId = 'whale', opponentId = 'daodun', { difficulty = 'normal', seed = 78 } = {}) {
  if (!['easy', 'normal'].includes(difficulty)) throw new TypeError('Unknown difficulty');
  return { fighters: [fighter(playerId, 0), fighter(opponentId, 1)], phase: 'countdown', countdown: 2.2, timeLeft: 90, elapsed: 0, paused: false, winner: null, reason: null, hitstop: 0, events: [], eventId: 0, projectiles: [], random: seededRandom(seed), difficulty, ai: { delay: 0, jumpCooldown: 0, input: blankInput() }, stats: { playerHits: 0, cpuHits: 0, blocks: 0, dodges: 0 } };
}
function emit(state, type, data = {}) {
  state.events.push({ id: ++state.eventId, type, ...data });
  if (state.events.length > 32) state.events.shift();
}
export function drainEvents(state) { return state.events.splice(0); }
function finish(state, reason) {
  const [a, b] = state.fighters;
  const ah = a.hp / ROSTER[a.id].health, bh = b.hp / ROSTER[b.id].health;
  state.winner = Math.abs(ah - bh) < 0.00001 ? 'draw' : ah > bh ? 0 : 1;
  state.reason = reason; state.phase = 'finished'; state.projectiles.length = 0;
  for (const f of state.fighters) { f.move = null; f.guard = false; f.vx = 0; f.controlled = 0; }
  emit(state, 'finish', { winner: state.winner, reason });
}
function beginMove(state, f, kind) {
  const heavy = kind === 'heavy', special = kind === 'skill';
  const cost = special ? 28 : heavy ? 20 : 7;
  if (f.move || f.attackCooldown > 0 || f.stamina < cost || (special && f.skillCooldown > 0)) return false;
  f.stamina -= cost;
  if (kind === 'light') { f.combo = f.comboWindow > 0 ? (f.combo % 3) + 1 : 1; f.comboWindow = 0.72; }
  else { f.combo = 0; f.comboWindow = 0; }
  const variant = special ? f.id : kind;
  const moves = {
    light: { windup: 0.085, active: 0.13, duration: 0.29, range: 128, damage: f.combo === 3 ? 10 : 7, knock: 215, lift: f.combo === 3 ? 210 : 50 },
    heavy: { windup: 0.26, active: 0.17, duration: 0.66, range: 174, damage: 18, knock: 410, lift: 230 },
    niwa: { windup: NIWA_SKILL.windup, active: NIWA_SKILL.interval * NIWA_SKILL.count, duration: NIWA_SKILL.duration, sonic: NIWA_SKILL, radial: true },
    daodun: { windup: DAODUN_SKILL.rushStart, active: DAODUN_SKILL.rushEnd - DAODUN_SKILL.rushStart, duration: DAODUN_SKILL.duration, rush: DAODUN_SKILL },
    whale: { windup: 0.25, active: 0.50, duration: 0.98, range: 0, damage: 16, knock: 290, lift: 130, projectile: true, burst: WHALE_SKILL },
  };
  f.move = { kind, ...moves[variant], time: 0, facing: f.facing, hit: false, spawned: false };
  if (variant === 'whale') f.move.nextShot = 0;
  if (variant === 'daodun') Object.assign(f.move, { phase: 'windup', rushHit: false, rushStopped: false, slashHit: false, slashEmitted: false });
  if (variant === 'niwa') Object.assign(f.move, { nextPulse: 0, pulse: null });
  f.action = kind; f.guard = false;
  if (special) f.skillCooldown = 5.5;
  emit(state, 'attack', { side: f.side, kind, x: f.x, y: f.y, facing: f.facing });
  return true;
}
function hit(state, source, target, move, direction) {
  if (target.hp <= 0 || target.invulnerable > 0) { if (target.invulnerable > 0) state.stats.dodges++; return false; }
  const facingAttack = target.facing === -direction;
  const shieldRush = target.move?.rush && target.move.time < target.move.rush.slashAt;
  const blocking = (target.guard || shieldRush) && facingAttack && target.grounded && target.stamina >= 10;
  const damage = blocking ? (move.chipDamage ?? 2) : move.damage;
  target.hp = Math.max(0, target.hp - damage); target.damage += damage; target.flash = move.flash ?? 0.18;
  target.vx = direction * move.knock * (blocking ? 0.22 : 1);
  if (blocking) { target.stamina = Math.max(0, target.stamina - (move.guardCost ?? 16)); target.stun = 0.07; state.stats.blocks++; }
  else {
    target.move = null; target.guard = false; target.stun = move.stun ?? (move.kind === 'light' ? 0.19 : 0.32);
    target.controlled = move.control ? target.stun : 0;
    if (!move.keepGrounded) { target.vy = move.lift; target.grounded = false; }
    target.action = 'hurt';
    source.comboHits = source.hitWindow > 0 ? source.comboHits + 1 : 1; source.hitWindow = 1.3;
    state.stats[source.side === 0 ? 'playerHits' : 'cpuHits']++;
  }
  state.hitstop = Math.max(state.hitstop, blocking ? (move.blockHitstop ?? 0.035) : (move.hitstop ?? (move.kind === 'light' ? 0.055 : 0.09)));
  emit(state, blocking ? 'block' : 'hit', { side: target.side, source: source.side, x: target.x, y: target.y + ROSTER[target.id].height * 0.6, damage, heavy: !move.control && move.kind !== 'light', combo: source.comboHits, skillPhase: move.skillPhase, pulse: move.pulse });
  return true;
}
function cpuInput(state) {
  const cpu = state.fighters[1], player = state.fighters[0], ai = state.ai;
  // Jump is a tap, unlike cached walking/guarding inputs: never auto-bounce on landing.
  ai.input.jump = false;
  if (ai.delay > 0) return ai.input;
  ai.delay = state.difficulty === 'easy' ? 0.29 + state.random() * 0.12 : 0.13 + state.random() * 0.10;
  const input = blankInput(), distance = Math.abs(player.x - cpu.x), roll = state.random();
  const advance = player.x < cpu.x ? 'left' : 'right';
  const retreat = player.x < cpu.x ? 'right' : 'left';
  const eager = state.difficulty === 'easy' ? 0.48 : 0.80;
  if (player.move && distance < 190 && roll < (state.difficulty === 'easy' ? 0.13 : 0.5)) input.guard = true;
  else if (distance > 136) input[advance] = true;
  else if (cpu.stamina < 20 && roll < 0.45) input[retreat] = true;
  else if (roll < eager) {
    if (cpu.skillCooldown <= 0 && roll < 0.2) input.skill = true;
    else if (roll < 0.44) input.heavy = true;
    else input.light = true;
  }
  if (cpu.id === 'whale' && distance > 230 && distance < 570 && cpu.skillCooldown <= 0 && roll < 0.65) input.skill = true;
  if (distance > 330 && cpu.dashCooldown <= 0 && roll > 0.87 && state.difficulty !== 'easy') input.dash = true;
  const canJump = cpu.grounded && !cpu.move && cpu.stun === 0 && cpu.action !== 'dash' && ai.jumpCooldown === 0;
  if (canJump && distance > 85 && distance < 620) {
    const projectileThreat = state.projectiles.some(p => p.source === 0 && (cpu.x - p.x) * p.vx > 0 && Math.abs(cpu.x - p.x) < 260 && p.y < 130);
    const move = player.move;
    const meleeThreat = player.y < 90 && move && (
      (move.sonic && distance < move.sonic.range + 30) ||
      (move.rush && distance < move.rush.slashRange + 70 && move.time < move.rush.slashAt + move.rush.slashActive) ||
      (move.kind === 'heavy' && distance < 210 && move.time < move.windup + move.active));
    const easy = state.difficulty === 'easy', chance = projectileThreat || meleeThreat ? (easy ? .32 : .72) : (easy ? .12 : .24);
    if (roll < chance) {
      input.jump = true; input.guard = input.dash = input.light = input.heavy = input.skill = false;
      input[advance] = true;
      ai.jumpCooldown = easy ? 3.8 : 2.4;
    }
  }
  ai.input = input; return input;
}
function updateFighter(state, f, input, opponent, dt) {
  const spec = ROSTER[f.id];
  for (const key of ['stun', 'controlled', 'invulnerable', 'flash', 'attackCooldown', 'skillCooldown', 'dashCooldown', 'comboWindow', 'hitWindow']) f[key] = Math.max(0, f[key] - dt);
  if (!f.hitWindow) f.comboHits = 0;
  f.stamina = Math.min(100, f.stamina + dt * (f.guard ? 4 : f.move ? 0 : 23));
  if (!f.move && f.stun === 0 && f.action !== 'dash') f.facing = opponent.x < f.x ? -1 : 1;
  f.guard = Boolean(input.guard && f.grounded && !f.move && f.stun === 0 && f.action !== 'dash' && f.stamina >= 10);
  if (f.stun > 0) f.action = 'hurt';
  else if (!f.move && f.action !== 'dash') {
    const move = (input.right ? 1 : 0) - (input.left ? 1 : 0);
    f.vx = move * spec.speed * (f.guard ? 0.28 : 1);
    if (input.jump && f.grounded && !f.guard) { f.vy = spec.jump; f.grounded = false; emit(state, 'jump', { side: f.side, x: f.x, y: 0 }); }
    if (input.dash && !f.guard && f.dashCooldown === 0 && f.stamina >= 22) {
      f.action = 'dash'; f.dashTime = 0.17; f.invulnerable = 0.12; f.dashCooldown = 0.8; f.stamina -= 22;
      f.dashDirection = move || f.facing; emit(state, 'dash', { side: f.side, x: f.x, y: f.y });
    } else if (!f.guard) {
      if (input.skill) beginMove(state, f, 'skill');
      else if (input.heavy) beginMove(state, f, 'heavy');
      else if (input.light) beginMove(state, f, 'light');
    }
    if (!f.move && f.action !== 'dash') f.action = f.guard ? 'guard' : !f.grounded ? 'jump' : move ? 'walk' : 'idle';
  }
  if (f.action === 'dash' && !f.move && f.stun === 0) {
    f.vx = f.dashDirection * 870; f.dashTime -= dt;
    if (f.dashTime <= 0) { f.action = 'idle'; f.vx *= 0.25; }
  }
  if (f.move) {
    const m = f.move;
    m.time += dt; f.action = m.kind;
    if (m.rush && m.time >= m.rush.rushStart && m.time < m.rush.rushEnd && !m.rushStopped) f.vx = m.facing * m.rush.speed;
    else f.vx *= Math.max(0, 1 - dt * 18);
    if (m.sonic) {
      m.pulse = null;
      if (m.nextPulse < m.sonic.count && m.time + 1e-9 >= m.sonic.windup + m.nextPulse * m.sonic.interval) {
        m.pulse = m.nextPulse++;
        emit(state, 'sonic', { side: f.side, stage: m.nextPulse, x: f.x, y: f.y });
      }
    }
    if (m.rush) {
      m.phase = m.time < m.rush.rushStart ? 'windup' : m.time < m.rush.rushEnd && !m.rushStopped ? 'rush' : m.time < m.rush.slashAt ? 'brace' : m.time < m.rush.slashAt + m.rush.slashActive ? 'cleave' : 'recover';
      if (!m.slashEmitted && m.time >= m.rush.slashAt) {
        m.slashEmitted = true;
        emit(state, 'cleave', { side: f.side, x: f.x, y: f.y, facing: m.facing });
      }
    }
    if (m.burst) {
      while (m.nextShot < m.burst.length && m.time >= m.burst[m.nextShot].at) {
        const index = m.nextShot++, shot = m.burst[index], last = index === m.burst.length - 1;
        if (state.projectiles.length < 6) state.projectiles.push({ x: f.x + m.facing * 95, y: f.y + 80, vx: m.facing * 600, ttl: 0.85, source: f.side, style: 'star', stage: index + 1,
          move: { kind: m.kind, damage: shot.damage, chipDamage: shot.chipDamage, guardCost: shot.guardCost, knock: last ? m.knock : 0, lift: last ? m.lift : 0, stun: last ? 0.32 : 0.12, hitstop: last ? 0.09 : 0.035 } });
        emit(state, 'star', { side: f.side, stage: index + 1, x: f.x + m.facing * 72, y: f.y + 80, facing: m.facing });
      }
    } else if (m.projectile && !m.spawned && m.time >= m.windup) {
      m.spawned = true;
      if (state.projectiles.length < 6) state.projectiles.push({ x: f.x + m.facing * 95, y: f.y + 80, vx: m.facing * 600, ttl: 0.85, source: f.side, move: { ...m } });
      emit(state, 'wave', { side: f.side, x: f.x, y: f.y });
    }
    if (m.time >= m.duration) { f.move = null; f.attackCooldown = 0.045; f.action = 'idle'; }
  }
  if (f.stun > 0) f.vx *= Math.max(0, 1 - dt * 4);
  f.x = clamp(f.x + f.vx * dt, ARENA.left, ARENA.right);
  if (!f.grounded || f.vy > 0) {
    f.y = Math.max(0, f.y + f.vy * dt); f.vy -= 1650 * dt;
    if (f.y === 0 && f.vy <= 0) { f.vy = 0; f.grounded = true; emit(state, 'land', { side: f.side, x: f.x, y: 0 }); }
  }
}
// Test callers may supply cpu input; normal gameplay always uses the local AI.
export function step(state, playerInput = {}, dt = 1 / 120, overrideCpu) {
  if (!Number.isFinite(dt) || dt <= 0 || dt > 1 / 30) throw new RangeError('Use bounded simulation steps');
  if (state.paused || state.phase === 'finished') return state;
  if (state.phase === 'countdown') {
    state.countdown = Math.max(0, state.countdown - dt);
    if (state.countdown === 0) { state.phase = 'playing'; emit(state, 'start'); }
    return state;
  }
  if (state.hitstop > 0) { state.hitstop = Math.max(0, state.hitstop - dt); return state; }
  state.elapsed += dt; state.timeLeft = Math.max(0, state.timeLeft - dt); state.ai.delay -= dt;
  state.ai.jumpCooldown = Math.max(0, state.ai.jumpCooldown - dt);
  const [a, b] = state.fighters;
  updateFighter(state, a, playerInput, b, dt);
  updateFighter(state, b, overrideCpu ?? cpuInput(state), a, dt);
  // Only horizontal pushboxes; jumping over an opponent remains possible.
  if (Math.abs(a.y - b.y) < 80 && Math.abs(a.x - b.x) < 94) {
    const direction = a.x <= b.x ? 1 : -1, overlap = (94 - Math.abs(a.x - b.x)) / 2;
    a.x = clamp(a.x - overlap * direction, ARENA.left, ARENA.right);
    b.x = clamp(b.x + overlap * direction, ARENA.left, ARENA.right);
  }
  // Resolve attacks after both fighters have updated, avoiding per-frame position bias.
  const attacks = state.fighters.map(f => ({ f, m: f.move }));
  for (const { f, m } of attacks) {
    if (m?.sonic) {
      if (m.pulse !== null) {
        const other = state.fighters[1 - f.side], dx = other.x - f.x;
        if (Math.abs(dx) <= m.sonic.range && Math.abs(other.y - f.y) < 116) {
          hit(state, f, other, { kind: 'skill', skillPhase: 'sonic', pulse: m.pulse + 1, damage: 1, chipDamage: [10, 20].includes(m.pulse) ? 1 : 0, guardCost: m.pulse < 16 ? 1 : 0, knock: 0, lift: 0, keepGrounded: true, stun: m.sonic.stun, control: true, flash: .045, hitstop: 0, blockHitstop: 0 }, dx >= 0 ? 1 : -1);
        }
      }
      continue;
    }
    if (m?.rush) {
      const other = state.fighters[1 - f.side], dx = other.x - f.x, forward = dx * m.facing > 0, dy = Math.abs(other.y - f.y), rush = m.rush;
      if (!m.rushHit && m.time >= rush.rushStart && m.time < rush.rushEnd && forward && Math.abs(dx) <= rush.contactRange && dy < 116) {
        m.rushHit = true;
        if (hit(state, f, other, { kind: 'skill', skillPhase: 'rush', damage: rush.collisionDamage, chipDamage: 0, guardCost: 6, knock: 380, lift: 0, stun: .48, hitstop: .06 }, m.facing)) { m.rushStopped = true; f.vx = 0; m.phase = 'brace'; }
      }
      if (!m.slashHit && m.time >= rush.slashAt && m.time < rush.slashAt + rush.slashActive && forward && Math.abs(dx) <= rush.slashRange && dy < 145) {
        m.slashHit = true;
        hit(state, f, other, { kind: 'skill', skillPhase: 'cleave', damage: rush.slashDamage, chipDamage: 2, guardCost: 10, knock: 640, lift: 210 }, m.facing);
      }
      continue;
    }
    if (!m || m.projectile || m.hit || m.time < m.windup || m.time >= m.windup + m.active) continue;
    const other = state.fighters[1 - f.side], dx = other.x - f.x;
    const reachable = Math.abs(dx) <= m.range && (m.radial || dx * m.facing > 0) && Math.abs(other.y - f.y) < 116;
    if (reachable) { m.hit = true; hit(state, f, other, m, dx >= 0 ? 1 : -1); }
  }
  state.projectiles = state.projectiles.filter(p => {
    p.x += p.vx * dt; p.ttl -= dt;
    const other = state.fighters[1 - p.source];
    if (Math.abs(other.x - p.x) < 68 && p.y > other.y && p.y < other.y + ROSTER[other.id].height) {
      hit(state, state.fighters[p.source], other, p.move, Math.sign(p.vx)); return false;
    }
    return p.ttl > 0 && p.x > 25 && p.x < ARENA.width - 25;
  });
  if (a.hp === 0 || b.hp === 0) finish(state, 'knockout');
  else if (state.timeLeft === 0) finish(state, 'time');
  return state;
}
