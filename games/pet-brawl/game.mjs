import { ARENA, ROSTER, WHALE_SKILL, createMatch, step, drainEvents } from './engine.mjs';
import { createSkillVoice } from './sound.mjs';
import { NIWA_LAUGH_FRAMES, laughFrameIndex, prepareLaughFrame } from './niwa-animation.mjs';
import { BrawlClient } from './online-client.mjs';

const $ = id => document.getElementById(id);
const canvas = $('arena'), ctx = canvas.getContext('2d', { alpha: false });
const images = new Map(), inputs = Object.create(null), effects = [];
const laughFrames = [];
const queuedInputs = Object.create(null);
const tapActions = new Set(['jump', 'light', 'heavy', 'skill', 'dash']);
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
let match = null, selected = 'whale', last = 0, accumulator = 0, sceneTime = 0, shake = 0, ready = false, audio = null, soundOn = true;
let cameraY = 0;
let onlineClient = null, networked = false, localSide = 0, networkRound = null, networkResultShown = false, onlineBusy = false, networkEnded = false;
const onlineEvents = [];
function sideLabel(side) { return networked ? `P${side + 1} · ${side === localSide ? '你' : '对手'}` : side === 0 ? 'P1 · 你' : 'CPU · 电脑'; }
const niwaVoiceSides = new Set();
// Fixed, bounded pool: mirror fighters share asset URLs, never playback state.
const skillVoices = new Map([0, 1].flatMap(side => ['whale', 'daodun', 'niwa'].map(id => {
  const media = new Audio(`./assets/${id}-skill.wav`); media.id = `${side === 0 ? '' : 'cpu-'}${id}-voice`; media.preload = 'auto';
  media.hidden = true; document.body.append(media);
  return [`${side}:${id}`, createSkillVoice(media, soundOn)];
})));
const keyMap = { KeyA: 'left', ArrowLeft: 'left', KeyD: 'right', ArrowRight: 'right', KeyW: 'jump', ArrowUp: 'jump', KeyJ: 'light', KeyK: 'heavy', KeyU: 'skill', KeyS: 'guard', Space: 'dash' };
const palette = { ground: '#f1e7ef', ink: '#766283', purple: '#8c72cd' };

function roundRect(x, y, w, h, radius, fill) { ctx.fillStyle = fill; ctx.beginPath(); ctx.roundRect(x, y, w, h, radius); ctx.fill(); }
function ellipse(x, y, rx, ry, color) { ctx.fillStyle = color; ctx.beginPath(); ctx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2); ctx.fill(); }
function path(points, color) { ctx.fillStyle = color; ctx.beginPath(); ctx.moveTo(...points[0]); for (const p of points.slice(1)) ctx.lineTo(...p); ctx.closePath(); ctx.fill(); }
function cloud(x, y, size, opacity = 0.5) {
  ctx.save(); ctx.globalAlpha = opacity;
  ellipse(x, y, size * 1.4, size * 0.36, '#fff'); ellipse(x - size * .4, y - size * .22, size * .6, size * .5, '#fff'); ellipse(x + size * .2, y - size * .35, size * .6, size * .6, '#fff'); ctx.restore();
}
function star(x, y, radius, alpha = 1) {
  ctx.save(); ctx.globalAlpha *= alpha; ctx.translate(x, y);
  const glow = ctx.createRadialGradient(0, 0, 1, 0, 0, radius * 2.3);
  glow.addColorStop(0, '#fffcdbee'); glow.addColorStop(.3, '#ffe76dbb'); glow.addColorStop(1, '#ffd54700');
  ctx.fillStyle = glow; ctx.fillRect(-radius * 2.3, -radius * 2.3, radius * 4.6, radius * 4.6);
  ctx.fillStyle = '#ffe37c'; ctx.beginPath();
  for (let i = 0; i < 16; i++) { const a = i * Math.PI / 8, r = i % 2 ? radius * .56 : radius; const x = Math.cos(a) * r, y = Math.sin(a) * r; if (!i) ctx.moveTo(x, y); else ctx.lineTo(x, y); }
  ctx.closePath(); ctx.fill(); ellipse(0, 0, radius * .5, radius * .5, '#fff6ae'); ctx.restore();
}
function whalePalmPulse(move) {
  return Math.max(...WHALE_SKILL.map(shot => Math.max(0, 1 - Math.abs(move.time - shot.at) / .12)));
}
function drawWhalePalm(f, move) {
  // Native Canvas sleeve/palm articulation over the unchanged source sprite.
  // The reference gesture holds one hand at the chest and pushes the other out.
  const pulse = whalePalmPulse(move), facing = move.facing;
  const x = facing * (23 + 42 * pulse), y = -77 - pulse * 4;
  ctx.save(); ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.strokeStyle = '#273455'; ctx.lineWidth = 19; ctx.beginPath(); ctx.moveTo(facing * 10, -76); ctx.quadraticCurveTo(facing * 28, -70, x - facing * 6, y); ctx.stroke();
  ctx.strokeStyle = '#41547c'; ctx.lineWidth = 13; ctx.stroke();
  ellipse(x - facing * 5, y, 4, 9, '#eee5e7');
  ctx.fillStyle = '#f8dacb'; ctx.strokeStyle = '#745a63'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.ellipse(x + facing * 3, y, 6, 7, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  if (pulse > .25) {
    ctx.strokeStyle = '#f8dacb'; ctx.lineWidth = 3.3;
    for (let i = -1; i <= 2; i++) { ctx.beginPath(); ctx.moveTo(x + facing * 5, y + i * 2.5); ctx.lineTo(x + facing * (13 - Math.abs(i) * 1.5), y + i * 4); ctx.stroke(); }
    if (move.time < .79) star(x + facing * 22, y - 1, 9 + pulse * 3, .8);
  }
  ctx.restore();
}
function landscape() {
  const sky = ctx.createLinearGradient(0, 0, 0, 510); sky.addColorStop(0, '#e5dff9'); sky.addColorStop(.68, '#f1e5ee'); sky.addColorStop(1, '#f6dfe0');
  ctx.fillStyle = sky; ctx.fillRect(0, 0, ARENA.width, ARENA.height);
  const glow = ctx.createRadialGradient(600, 185, 5, 600, 230, 330); glow.addColorStop(0, '#fff9eeaa'); glow.addColorStop(1, '#fff9ee00'); ctx.fillStyle = glow; ctx.fillRect(0, 0, 1200, 500);
  ellipse(925, 166, 47, 47, '#fff8ec88');
  cloud(210 + Math.sin(sceneTime * .08) * 7, 165, 70, .33); cloud(1030, 245, 85, .3); cloud(550, 126, 45, .27);
  path([[0, 356], [95, 272], [185, 330], [300, 245], [423, 360], [530, 290], [646, 367], [773, 260], [880, 337], [1010, 267], [1200, 375], [1200, 520], [0, 520]], '#cbc1df77');
  path([[0, 408], [130, 330], [245, 390], [398, 319], [530, 427], [717, 355], [880, 409], [1037, 340], [1200, 430], [1200, 540], [0, 540]], '#b9a9cd77');
  path([[0, 438], [95, 420], [240, 443], [390, 414], [535, 455], [745, 420], [960, 452], [1090, 412], [1200, 434], [1200, 555], [0, 555]], '#c8b3cb');
  const floor = ctx.createLinearGradient(0, 456, 0, 640); floor.addColorStop(0, '#f6e7ea'); floor.addColorStop(1, '#ece0ee');
  ctx.fillStyle = floor; ctx.fillRect(0, 457, 1200, 183);
  ellipse(600, 512, 525, 61, '#f9eff377');
  ctx.strokeStyle = '#d6c4db88'; ctx.lineWidth = 1;
  for (const x of [-200, 10, 220, 430, 640, 850, 1060, 1270]) { ctx.beginPath(); ctx.moveTo(600 + (x - 600) * .65, 458); ctx.lineTo(x, 640); ctx.stroke(); }
  for (const y of [483, 528, 591]) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(1200, y); ctx.stroke(); }
  // Stage edges are decorative, while the simulation clamps all fighters inside them.
  for (const [x, direction] of [[43, 1], [1157, -1]]) {
    roundRect(x - 12, 379, 24, 106, 5, '#d4bed5'); roundRect(x - 19, 377, 38, 11, 3, '#e3cfe0');
    ctx.fillStyle = '#efdeed'; ctx.fillRect(x + direction * 7, 393, direction * 47, 7); ctx.fillRect(x + direction * 7, 419, direction * 47, 6);
    ellipse(x, 375, 9, 8, '#dfcbdf');
  }
  for (const [x, y] of [[144, 431], [1070, 440], [75, 449], [1130, 449]]) {
    path([[x - 8, y], [x - 5, y - 21], [x, y - 5], [x + 7, y - 28], [x + 7, y - 3], [x + 15, y - 15], [x + 12, y + 2]], '#9b94b4');
  }
  ctx.save(); ctx.globalAlpha = .28; ctx.strokeStyle = '#b8a4ce'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.ellipse(600, 507, 310, 40, 0, 0, Math.PI * 2); ctx.stroke(); ctx.restore();
}
function drawSprite(f, preview = false) {
  const spec = ROSTER[f.id], img = images.get(f.id); if (!img) return;
  const walk = f.action === 'walk' ? Math.sin(sceneTime * 17) : 0;
  const idle = !reducedMotion && ['idle', 'guard'].includes(f.action) ? Math.sin(sceneTime * 2.7 + f.side * 1.6) : 0;
  const m = f.move, progress = m ? m.time / m.duration : 0;
  let lean = walk * .035, sx = 1 + idle * .012, sy = 1 - idle * .012, extraY = Math.abs(walk) * 3;
  if (m) {
    const active = m.time >= m.windup && m.time < m.windup + m.active;
    const anticip = m.time < m.windup;
    lean = m.facing * (anticip ? -.11 : active ? .24 : .06);
    sx = anticip ? .92 : active ? 1.12 : 1; sy = anticip ? 1.05 : active ? .92 : 1;
    if (m.sonic) { lean = reducedMotion ? 0 : Math.sin(m.time * 27) * .045; sx = 1; sy = reducedMotion ? 1 : 1 + Math.sin(m.time * 27) * .025; extraY = 0; }
    if (m.kind === 'skill' && f.id === 'whale') { const pulse = whalePalmPulse(m); extraY += reducedMotion ? 0 : pulse * 3; lean = reducedMotion ? 0 : m.facing * (-.035 + pulse * .1); sx = 1 + pulse * .025; sy = 1 - pulse * .02; }
    if (m.rush) { lean = m.facing * (m.phase === 'rush' ? .23 : m.phase === 'cleave' ? -.13 + .4 * (m.time - m.rush.slashAt) / m.rush.slashActive : -.07); sx = m.phase === 'rush' ? 1.09 : 1; sy = m.phase === 'rush' ? .92 : 1; }
  }
  if (f.action === 'hurt') { lean = -f.facing * .17; sx = 1.07; sy = .92; }
  if (f.action === 'dash') { lean = f.dashDirection * .27; sx = 1.13; sy = .88; }
  if (f.guard) { sy = .94; lean = -f.facing * .06; }
  const dead = match?.phase === 'finished' && f.hp === 0;
  if (dead) { sy = .78; lean = -f.facing * .28; }
  ellipse(f.x, ARENA.floor + 5, spec.width * .44, 12 - Math.min(7, f.y * .025), '#82709224');
  if (!preview) {
    ctx.save(); ctx.strokeStyle = f.side === 0 ? '#7160ddaa' : '#c77b36bb'; ctx.lineWidth = 2.5;
    ctx.beginPath(); ctx.ellipse(f.x, ARENA.floor + 5, spec.width * .43, 11, 0, 0, Math.PI * 2); ctx.stroke(); ctx.restore();
  }
  ctx.save(); ctx.translate(f.x, ARENA.floor - f.y - extraY); ctx.rotate(lean); ctx.scale(sx, sy);
  if (f.invulnerable > 0 || f.action === 'dash') { ctx.globalAlpha = .18; ctx.drawImage(img, -spec.width / 2 - f.dashDirection * 45, -spec.height, spec.width, spec.height); ctx.globalAlpha = 1; }
  ctx.shadowColor = f.flash > 0 ? '#fff' : spec.color + '33'; ctx.shadowBlur = f.flash > 0 ? 20 : 7;
  if (f.flash > 0) ctx.filter = 'brightness(1.7) saturate(.5)';
  // Keep the original artwork unmirrored: knife/ shield never swap hands.
  if (m?.rush && m.phase === 'rush' && !reducedMotion) {
    ctx.filter = 'none'; ctx.shadowBlur = 0;
    for (const [offset, alpha] of [[65, .10], [35, .20]]) { ctx.globalAlpha = alpha; ctx.drawImage(img, -spec.width / 2 - m.facing * offset, -spec.height, spec.width, spec.height); }
    ctx.globalAlpha = 1;
  }
  const laugh = m?.sonic ? laughFrames[laughFrameIndex(m.time, reducedMotion)] : null;
  if (laugh) ctx.drawImage(laugh, -65, -202, 130, 202); else ctx.drawImage(img, -spec.width / 2, -spec.height, spec.width, spec.height);
  if (m?.kind === 'skill' && f.id === 'whale') { ctx.filter = 'none'; ctx.shadowBlur = 0; drawWhalePalm(f, m); }
  ctx.restore();
  if (f.controlled > 0) {
    ctx.save(); ctx.fillStyle = '#bd9d37'; ctx.font = '700 15px "Segoe UI",sans-serif'; ctx.textAlign = 'center';
    for (let i=0; i<3; i++) { const angle=i*Math.PI*2/3+(reducedMotion?0:sceneTime*6); ctx.fillText('✦',f.x+Math.cos(angle)*24,ARENA.floor-f.y-spec.height-8+Math.sin(angle)*6); }
    ctx.restore();
  }
  if (f.guard) {
    ctx.save(); ctx.strokeStyle = '#8b9fe0cc'; ctx.fillStyle = '#c9d9fb35'; ctx.lineWidth = 3; const cx = f.x + f.facing * 50;
    ctx.beginPath(); ctx.ellipse(cx, ARENA.floor - f.y - 80, 20, 60, f.facing * -.1, 0, Math.PI * 2); ctx.fill(); ctx.stroke(); ctx.restore();
  }
  if (m) drawAttack(f, m, spec);
  if (preview) {
    ctx.textAlign = 'center'; ctx.font = '600 13px "Segoe UI", "Microsoft YaHei", sans-serif'; ctx.fillStyle = '#7b688f'; ctx.fillText(spec.name, f.x, ARENA.floor + 38);
    ctx.font = '9px "Segoe UI", "Microsoft YaHei", sans-serif'; ctx.fillStyle = '#a38fb5'; ctx.fillText(spec.subtitle, f.x, ARENA.floor + 56);
  } else {
    const bodyHeight = Math.max(spec.height, m?.sonic ? 202 : 0), labelY = Math.max(6 - cameraY, ARENA.floor - f.y - bodyHeight - 27);
    ctx.save(); roundRect(f.x - 38, labelY, 76, 22, 11, f.side === 0 ? '#7160dd' : '#c77b36');
    ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.font = '700 11px "Segoe UI", "Microsoft YaHei", sans-serif';
    ctx.fillText(sideLabel(f.side), f.x, labelY + 11); ctx.restore();
    if (f.comboHits >= 2 && f.hitWindow > 0) { ctx.fillStyle = '#8d6ac4'; ctx.font = 'italic 800 21px "Segoe UI", sans-serif'; ctx.fillText(`${f.comboHits} HIT`, f.x, 235); }
  }
}
function drawAttack(f, m, spec) {
  const active = m.time >= m.windup && m.time < m.windup + m.active;
  const y = ARENA.floor - f.y - 73;
  ctx.save();
  if (m.sonic) {
    if (m.time >= m.windup && m.nextPulse <= m.sonic.count && m.time < m.windup + m.sonic.count*m.sonic.interval) {
      for (let i=0;i<3;i++) {
        const t=((m.time-m.windup)*3+i/3)%1;
        ctx.strokeStyle=`rgba(237,180,52,${(1-t)*.6})`;ctx.lineWidth=4*(1-t)+1;
        ctx.beginPath();ctx.ellipse(f.x,y,25+t*(m.sonic.range-25),18+t*86,0,0,Math.PI*2);ctx.stroke();
      }
      ctx.fillStyle='#bb8a23';ctx.font='800 20px "Microsoft YaHei",sans-serif';ctx.textAlign='center';ctx.fillText('哈 哈 哈',f.x,ARENA.floor-f.y-211);
    }
    ctx.restore();return;
  }
  if (m.rush) {
    ctx.translate(f.x, y); ctx.scale(m.facing, 1);
    if (m.phase === 'windup') {
      ctx.setLineDash([7, 7]); ctx.strokeStyle = '#d9a65f99'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(70, 77); ctx.lineTo(m.rush.slashRange, 77); ctx.stroke();
    } else if (m.phase === 'rush') {
      ctx.strokeStyle = '#fff6d8'; ctx.lineWidth = 4; ctx.lineCap = 'round';
      for (const [x, lineY] of [[-90, -30], [-120, 0], [-100, 25]]) { ctx.beginPath(); ctx.moveTo(x, lineY); ctx.lineTo(x - 85, lineY); ctx.stroke(); }
      ctx.strokeStyle = '#efc16bcc'; ctx.lineWidth = 6; ctx.beginPath(); ctx.ellipse(73, -3, 20, 61, -.1, -1.5, 1.5); ctx.stroke();
    } else if (m.phase === 'cleave') {
      const t = (m.time - m.rush.slashAt) / m.rush.slashActive, radius = m.rush.slashRange - 12;
      ctx.fillStyle = '#ffe3a04d'; ctx.beginPath(); ctx.moveTo(25, 0); ctx.arc(25, 0, radius - 25, -.95, .9); ctx.closePath(); ctx.fill();
      ctx.shadowColor = '#f8ba50'; ctx.shadowBlur = 18; ctx.strokeStyle = '#ffefb9'; ctx.lineWidth = 22 * Math.sin(Math.PI * t) + 6;
      ctx.beginPath(); ctx.arc(12, 0, radius - 12, -.95, -.65 + 1.55 * t); ctx.stroke();
      ctx.shadowBlur = 0; ctx.strokeStyle = '#fffdf3'; ctx.lineWidth = 4; ctx.beginPath(); ctx.arc(12, 0, radius - 12, -.95, -.65 + 1.55 * t); ctx.stroke();
      ctx.rotate(-.95 + 1.85 * t); path([[45, -12], [radius + 3, -4], [radius - 4, 9], [45, 13]], '#fff8dfee');
    }
    ctx.restore(); return;
  }
  if (m.burst) {
    for (let i = m.nextShot; i < WHALE_SKILL.length; i++) {
      const angle = -2.1 + i * 1.9 + (reducedMotion ? 0 : m.time * .65);
      star(f.x + Math.cos(angle) * 74, ARENA.floor - f.y - 112 + Math.sin(angle) * 55, 8 + i, Math.min(1, m.time * 6));
    }
  }
  if (m.time < m.windup && m.kind !== 'light') {
    ctx.setLineDash([5, 6]); ctx.strokeStyle = '#d38d9c88'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.ellipse(f.x + (m.radial ? 0 : m.facing * 75), ARENA.floor + 4, m.radial ? 185 : 95, 14, 0, 0, Math.PI * 2); ctx.stroke();
    ctx.setLineDash([]);
  }
  if (active && !m.projectile) {
    const power = Math.sin((m.time - m.windup) / m.active * Math.PI), range = m.kind === 'light' ? 94 : 136;
    if (m.radial) {
      ctx.strokeStyle = '#f5c365cc'; ctx.lineWidth = 9 * power + 2; ctx.beginPath(); ctx.ellipse(f.x, ARENA.floor + 1, 50 + power * 150, 9 + power * 16, 0, 0, Math.PI * 2); ctx.stroke();
    } else {
      ctx.translate(f.x + m.facing * 40, y); ctx.scale(m.facing, 1);
      ctx.shadowColor = spec.color; ctx.shadowBlur = 14; ctx.strokeStyle = '#fff9ea'; ctx.lineWidth = m.kind === 'light' ? 12 : 20; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.arc(0, 0, range * power + 20, -.9, .85); ctx.stroke();
      ctx.shadowBlur = 0; ctx.strokeStyle = spec.color + 'b0'; ctx.lineWidth = 4; ctx.beginPath(); ctx.arc(0, 0, range * power + 30, -1.0, .8); ctx.stroke();
    }
  }
  ctx.restore();
}
function drawEffects(dt) {
  for (let i = effects.length - 1; i >= 0; i--) {
    const e = effects[i]; e.life -= dt;
    if (e.life <= 0) { effects.splice(i, 1); continue; }
    const t = 1 - e.life / e.duration, x = e.x, y = ARENA.floor - e.y;
    ctx.save(); ctx.globalAlpha = Math.min(1, e.life * 5);
    if (e.type === 'hit' || e.type === 'block') {
      const particles = e.skillPhase === 'sonic' ? 3 : 9;
      for (let n = 0; n < particles; n++) {
        const angle = n * Math.PI * 2 / particles + .2, length = (e.skillPhase === 'sonic' ? 25 : e.heavy ? 72 : 48) * t;
        ctx.strokeStyle = n % 2 ? '#fff9e5' : e.type === 'block' ? '#a0bef9' : '#efb869'; ctx.lineWidth = 4 * (1 - t) + 1;
        ctx.beginPath(); ctx.moveTo(x + Math.cos(angle) * length * .45, y + Math.sin(angle) * length * .45); ctx.lineTo(x + Math.cos(angle) * length, y + Math.sin(angle) * length); ctx.stroke();
      }
      ctx.fillStyle = e.type === 'block' ? '#8a9bd1' : '#bb795d'; ctx.textAlign = 'center'; ctx.font = `800 ${e.skillPhase === 'sonic' ? 17 : 22}px "Segoe UI",sans-serif`; ctx.fillText(e.type === 'block' ? '格挡' : `−${e.damage}`, x + 18, y - 35 - t * 52);
    } else if (['jump', 'land', 'dash'].includes(e.type)) {
      for (let n = 0; n < 4; n++) ellipse(x - 30 + n * 20, ARENA.floor - 2 - t * 11, 8 + t * 10, 5 + t * 4, '#fff7ed');
    }
    ctx.restore();
  }
}
function tone(type) {
  if (!soundOn || !audio) return;
  const oscillator = audio.createOscillator(), gain = audio.createGain(), now = audio.currentTime;
  const pitch = type === 'block' ? 700 : type === 'finish' ? 290 : type === 'attack' ? 180 : 120;
  oscillator.type = type === 'block' ? 'sine' : 'triangle'; oscillator.frequency.setValueAtTime(pitch, now); oscillator.frequency.exponentialRampToValueAtTime(Math.max(38, pitch * .35), now + .1);
  gain.gain.setValueAtTime(0.0001, now); gain.gain.exponentialRampToValueAtTime(.07, now + .008); gain.gain.exponentialRampToValueAtTime(.0001, now + .15);
  oscillator.connect(gain); gain.connect(audio.destination); oscillator.start(now); oscillator.stop(now + .17);
}
function syncHud() {
  if (!match) return;
  const self = match.fighters[localSide], other = match.fighters[1 - localSide];
  // Read-only render metadata, never accepted as simulation input or authority.
  canvas.dataset.phase = match.phase;
  canvas.dataset.networked = String(networked); canvas.dataset.localSide = String(localSide);
  canvas.dataset.playerX = String(Math.round(self.x));
  canvas.dataset.playerY = String(Math.round(self.y));
  canvas.dataset.cpuX = String(Math.round(other.x));
  canvas.dataset.cpuY = String(Math.round(other.y));
  canvas.dataset.playerAction = self.action;
  canvas.dataset.playerSkillStage = String(self.move?.nextPulse ?? self.move?.nextShot ?? 0);
  canvas.dataset.cpuControlled = String(other.controlled > 0);
  canvas.dataset.playerLaughFrame = self.move?.sonic ? String(laughFrameIndex(self.move.time, reducedMotion)) : '';
  canvas.dataset.playerSkillPhase = self.move?.phase ?? '';
  for (const [i, prefix] of [[localSide, 'player'], [1 - localSide, 'cpu']]) {
    const f = match.fighters[i], spec = ROSTER[f.id], pct = f.hp / spec.health * 100;
    $(`${prefix}-health`).style.width = `${pct}%`; $(`${prefix}-health-trail`).style.width = `${pct}%`; $(`${prefix}-stamina`).style.width = `${f.stamina}%`;
    $(`${prefix}-health-label`).textContent = `${f.hp} / ${spec.health}`;
  }
  $('timer').textContent = String(Math.ceil(match.timeLeft)).padStart(2, '0'); $('timer').parentElement.classList.toggle('urgent', match.timeLeft < 15);
  const f = self; $('skill-status').textContent = f.move?.sonic ? `大笑声波 ${f.move.nextPulse}/21 · 每次1点＋短暂僵直` : f.move?.rush ? ({windup: '举盾蓄力', rush: '冲刺 · 碰撞击退', brace: '停步蓄斩', cleave: '前方大范围横斩', recover: '收招 · 全中20'})[f.move.phase] : f.id === 'whale' && f.move?.burst ? `已发 ${f.move.nextShot}/3 段 · 三段全中16` : f.skillCooldown > 0 ? `${f.skillCooldown.toFixed(1)}秒后就绪` : f.stamina < 28 ? '体力恢复中' : '技能就绪 · U';
}
function notifyInput(release = false) { if (networked && !networkEnded) onlineClient?.setInput(inputs, {release}); }
function clearInputs() { for (const source of [inputs, queuedInputs]) for (const key of Object.keys(source)) delete source[key]; document.querySelectorAll('.held').forEach(el => el.classList.remove('held')); notifyInput(true); }
function showResult(paused = false) {
  for (const voice of skillVoices.values()) { if (paused) voice.pause(); else voice.stop(); }
  $('overlay').hidden = false; $('resume').hidden = !paused; $('rematch').hidden = paused;
  $('result-stats').replaceChildren();
  if (paused) { $('result-icon').textContent = 'Ⅱ'; $('result-eyebrow').textContent = 'TAKE A BREATHER'; $('result-title').textContent = '歇一下，战场等你。'; $('result-description').textContent = '时间与双方动作都已暂停。准备好再继续。'; }
  else {
    if (networked) networkResultShown = true;
    const won = match.winner === localSide, draw = match.winner === 'draw';
    $('result-icon').textContent = draw ? '◇' : won ? '✦' : '↻'; $('result-eyebrow').textContent = draw ? 'A PERFECT TIE' : won ? 'NICELY DONE' : 'ONE MORE TRY';
    const mirror = match.fighters[0].id === match.fighters[1].id;
    const playerName = ROSTER[match.fighters[localSide].id].name + (mirror ? `（${sideLabel(localSide)}）` : '');
    const cpuName = ROSTER[match.fighters[1 - localSide].id].name + (mirror ? `（${sideLabel(1 - localSide)}）` : '');
    $('result-title').textContent = draw ? '势均力敌，再来一次？' : won ? `${playerName}赢啦！` : `${cpuName}赢下这一局`;
    $('result-description').textContent = match.reason === 'time' ? '时间到，按双方剩余生命比例判定。' : won ? '抓住破绽，漂亮收招。下一局也要加油。' : '没关系！试着先防御，再抓住重击后的空档。';
    for (const [value, label] of [[match.stats[localSide === 0 ? 'playerHits' : 'cpuHits'], '你的命中'], [match.stats.blocks, '全场格挡'], [Math.round(match.elapsed), '对战秒数']]) { const box = document.createElement('span'), b = document.createElement('b'); b.textContent = value; box.append(b, label); $('result-stats').append(box); }
    $('announcement').textContent = $('result-title').textContent;
  }
  clearInputs();
}
function pauseGame() {
  if (!match || match.phase === 'finished') return;
  if (networked) {
    clearInputs(); $('overlay').hidden = false; $('resume').hidden = false; $('rematch').hidden = true; $('result-stats').replaceChildren();
    $('result-title').textContent = '联机菜单'; $('result-description').textContent = '对战仍在继续。返回后恢复操作，离开会结束本局。'; return;
  }
  match.paused = true; showResult(true); $('announcement').textContent = '对战已暂停';
}
function resumeGame() { if (!match || (!networked && !match.paused)) return; if (!networked) match.paused = false; clearInputs(); $('overlay').hidden = true; last = 0; accumulator = 0; canvas.focus({ preventScroll: true }); if (soundOn) audio?.resume().catch(() => {}); for (const voice of skillVoices.values()) voice.resume(); }
function startGame() {
  if (!ready) return;
  if (networked) { if (match?.phase === 'finished' && !networkEnded) onlineClient?.action('rematch').catch(error => { $('result-description').textContent = error.message; }); return; }
  if ($('battle-mode').value === 'online') { requestOnline('auto'); return; }
  localSide = 0; networkEnded = false;
  for (const voice of skillVoices.values()) voice.stop();
  niwaVoiceSides.clear();
  match = createMatch(selected, $('opponent').value, { difficulty: $('difficulty').value, seed: 37 + Math.floor(performance.now()) });
  effects.length = 0; shake = 0; cameraY = 0; clearInputs(); accumulator = 0;
  enterArena();
  syncHud(); canvas.focus({ preventScroll: true }); if (soundOn) { audio ??= new AudioContext(); audio.resume().catch(() => {}); }
  $('announcement').textContent = '对战准备开始';
}
function lobby() {
  const client = onlineClient; onlineClient = null; if (client) client.leave().catch(() => client.close());
  networked = false; networkEnded = false; localSide = 0; networkRound = null; onlineEvents.length = 0; onlineBusy = false;
  canvas.dataset.networked = 'false'; canvas.dataset.phase = 'lobby'; delete canvas.dataset.room; delete canvas.dataset.round;
  for (const voice of skillVoices.values()) voice.stop(); niwaVoiceSides.clear(); match = null; cameraY = 0; clearInputs(); effects.length = 0;
  $('overlay').hidden = true; $('hud').hidden = true; $('arena-footer').hidden = true; $('lobby-hint').hidden = false; $('setup').hidden = false; $('online-waiting').hidden = true;
  canvas.parentElement.classList.remove('playing'); setOnlineLock(false); updateMode();
  canvas.parentElement.classList.remove('online-playing');
}
function enterArena() {
  $('hud').hidden = false; $('arena-footer').hidden = false; $('lobby-hint').hidden = true; $('overlay').hidden = true; $('setup').hidden = true; $('online-waiting').hidden = true;
  canvas.parentElement.classList.add('playing'); document.querySelector('.app').classList.toggle('local-p2', localSide === 1);
  canvas.parentElement.classList.toggle('online-playing',networked);
  for (const [side,prefix] of [[localSide,'player'],[1-localSide,'cpu']]) {
    $(`${prefix}-name`).textContent = ROSTER[match.fighters[side].id].name;
    const tag = $(`${prefix}-side-label`); tag.textContent = sideLabel(side); tag.classList.toggle('player-tag',side===0); tag.classList.toggle('cpu-tag',side===1);
  }
  $('skill-label').textContent = ROSTER[match.fighters[localSide].id].skill;
  $('online-status').hidden = !networked; $('change').textContent = networked ? '离开对战' : '重新选伙伴'; $('resume').textContent = networked ? '返回对战' : '继续对战'; $('rematch').disabled = false;
  const pauseKey=document.createElement('kbd');pauseKey.textContent='Esc';$('pause').replaceChildren(document.createTextNode(networked?'菜单 ':'暂停 '),pauseKey);$('restart-top').hidden=networked;
}
function setOnlineLock(locked) {
  for (const element of document.querySelectorAll('#characters button, #battle-mode, #fight-code, #create-fight-code')) element.disabled = locked;
  $('start').disabled = locked || !ready;
}
function updateMode() {
  const human = $('battle-mode').value === 'online'; $('online-tools').hidden = !human; document.querySelector('.cpu-picker').hidden = human;
  if (!human && onlineClient && !networked) { const client = onlineClient; onlineClient = null; client.leave().catch(()=>client.close()); }
  $('local-online-note').textContent = human ? '有格斗码加入好友，留空随机匹配真人；仅限本地原型' : '随时与电脑练习，也可选择真人联机';
  document.querySelector('.setup-title>span').textContent = human ? '可选相同角色 · 入场后标明 P1/P2 和你/对手' : '可选相同角色 · 紫色 P1 是你，橙色 CPU 是对手';
  $('guide-extra').textContent = human ? 'A/D移动，W跳跃，J轻击，K重击，U技能，按住S正面防御，空格闪避。Esc打开菜单，不会暂停对手；重开须双方同意。切换窗口会释放自己的按键，对战继续进行。' : '也可用方向键移动、跳跃。重击有起手时间；靠近再出招，留一点体力给闪避。格挡只保护正面并消耗体力，空中不能格挡。技能冷却5.5秒。90秒后按剩余生命比例判胜，生命归零立即分出胜负。Esc暂停，R重新开始。切换窗口自动暂停。';
  if (!onlineBusy) $('start').textContent = human ? ($('fight-code').value.trim() ? '加入好友对战' : '随机匹配') : '开始乱斗';
}
async function requestOnline(kind) {
  if (onlineBusy || !ready) return; onlineBusy = true; setOnlineLock(true); $('online-waiting').hidden = false; $('room-code-box').hidden = true; $('online-message').textContent = '正在连接本地联机服务…';
  if (onlineClient) { const previous = onlineClient; onlineClient = null; previous.leave().catch(()=>previous.close()); }
  const client = new BrawlClient({onMessage:message => { if (onlineClient === client) receiveOnline(message); },onConnection:connected => { if (onlineClient === client && networked) $('online-status').textContent = connected ? '真人联机 · 连接正常' : '连接中断，正在重连…'; }});
  onlineClient = client;
  try {
    await client.connect(); if (onlineClient !== client) return;
    const code = $('fight-code').value.trim().toUpperCase();
    const type = kind === 'create' ? 'create' : code ? 'join' : 'queue';
    await client.action(type,{character:selected,...(type==='join'?{code}:{})});
  } catch (error) {
    if (onlineClient !== client) return; client.close(); onlineClient = null; onlineBusy = false; setOnlineLock(false); updateMode(); $('online-message').textContent = error.message;
  }
}
function receiveOnline(message) {
  if (message.type === 'lobby') {
    if (networked) { endOnline(message.message || '对战已结束'); return; }
    if (message.status === 'queued') { $('online-message').textContent = '正在随机匹配真人… 可以随时取消'; $('room-code-box').hidden = true; }
    else if (message.message) { $('online-message').textContent = message.message; onlineBusy = false; setOnlineLock(false); }
    return;
  }
  if (message.type !== 'room') return;
  if (message.status === 'waiting') { $('online-message').textContent = '房间已创建，等待朋友加入（格斗码10分钟有效）'; $('room-code').textContent = message.code; $('room-code-box').hidden = false; return; }
  if (message.status === 'aborted') { endOnline(message.message); return; }
  if (!message.state) return;
  const fresh = networkRound !== message.roundId, paused = match?.paused;
  localSide = message.side; networked = true; networkEnded = false; match = message.state; onlineClient.round = message.roundId; onlineClient.playing = message.status === 'playing';
  canvas.dataset.room = message.room; canvas.dataset.round = message.roundId;
  if (fresh) {
    networkRound = message.roundId; networkResultShown = false; onlineEvents.length = 0;
    effects.length = 0; shake = 0; cameraY = 0; niwaVoiceSides.clear(); for (const voice of skillVoices.values()) voice.stop();
    clearInputs(); enterArena(); if (!document.hidden) canvas.focus({preventScroll:true}); if (soundOn) { audio ??= new AudioContext(); audio.resume().catch(()=>{}); }
  }
  onlineEvents.push(...message.events); if (onlineEvents.length > 128) onlineEvents.splice(0,onlineEvents.length-128);
  if (match.paused !== paused) for (const voice of skillVoices.values()) { if (match.paused) voice.pause(); else voice.resume(); }
  $('online-status').textContent = match.paused ? '对手连接中 · 最多等待15秒' : `真人联机 · 你是 P${localSide+1}`;
  if (match.phase === 'finished') {
    if (!networkResultShown) showResult();
    $('rematch').textContent = message.rematch[localSide] ? '已申请，等待对手' : '申请再来一局'; $('rematch').disabled = message.rematch[localSide];
  }
  syncHud();
}
function endOnline(message) {
  networkEnded = true; if (onlineClient) onlineClient.playing = false;
  onlineEvents.length = 0; niwaVoiceSides.clear();
  if (!match) { $('online-message').textContent = message; onlineBusy = false; setOnlineLock(false); return; }
  match.paused = true; clearInputs(); for (const voice of skillVoices.values()) voice.stop();
  $('overlay').hidden = false; $('resume').hidden = true; $('rematch').hidden = true; $('result-stats').replaceChildren();
  $('result-title').textContent = message || '联机对战已结束'; $('result-description').textContent = '返回选角后可以重新约战、随机匹配或选择人机对战。';
}
function combatEvents(events) {
  for (const e of events) {
    if (['hit','block','jump','land','dash'].includes(e.type)) { const duration=e.skillPhase==='sonic'?.22:.52; effects.push({...e,duration,life:duration}); if(effects.length>48)effects.shift(); }
    if(e.type==='hit'&&e.skillPhase!=='sonic')shake=e.heavy?7:4;
    if(e.type==='attack'&&e.kind==='skill'){const id=match.fighters[e.side]?.id;skillVoices.get(`${e.side}:${id}`)?.play();if(id==='niwa')niwaVoiceSides.add(e.side);}
    if(['hit','block','attack','star','cleave','finish'].includes(e.type))tone(e.type);
    if(e.type==='finish'){if(!networked||!networkResultShown)showResult();else for(const voice of skillVoices.values())voice.stop();}
  }
  for(const side of niwaVoiceSides)if(!match.fighters[side]?.move?.sonic){skillVoices.get(`${side}:niwa`).stop();niwaVoiceSides.delete(side);}
}
function frame(now) {
  const dt = last ? Math.min((now - last) / 1000, .05) : 0; last = now;
  if (!match?.paused) sceneTime += dt;
  if (match && networked) { combatEvents(onlineEvents.splice(0)); syncHud(); }
  else if (match && !match.paused && match.phase !== 'finished') {
    accumulator += dt;
    while (accumulator >= 1 / 120) {
      // Preserve short key taps even if down/up both arrived between render frames.
      step(match, { ...inputs, ...queuedInputs });
      for (const key of Object.keys(queuedInputs)) delete queuedInputs[key];
      accumulator -= 1 / 120;
    }
    combatEvents(drainEvents(match));
    syncHud();
  }
  // Follow only the extra height: world positions and hit detection are unchanged.
  // Rise as soon as needed to keep heads/labels visible, return gently on descent.
  if (!match?.paused) {
    const top = match ? Math.max(...match.fighters.map(f => f.y + Math.max(ROSTER[f.id].height, f.move?.sonic ? 202 : 0) + 30)) : 0;
    const target = Math.max(0, Math.min(96, top - ARENA.floor));
    cameraY = Math.max(target, cameraY - dt * 220);
  }
  canvas.dataset.cameraY = String(cameraY);
  if (match) {
    const f = match.fighters[localSide];
    canvas.dataset.playerScreenTop = String(ARENA.floor - f.y - Math.max(ROSTER[f.id].height, f.move?.sonic ? 202 : 0) + cameraY);
  }
  ctx.fillStyle = '#e5dff9'; ctx.fillRect(0, 0, ARENA.width, ARENA.height);
  ctx.save(); ctx.translate(0, cameraY);
  if (shake > 0 && !reducedMotion && !match?.paused) { ctx.translate(Math.sin(now * .13) * shake, Math.cos(now * .15) * shake * .5); shake *= .78; if (shake < .1) shake = 0; }
  landscape();
  if (match) {
    for (const f of match.fighters) drawSprite(f);
    for (const p of match.projectiles) {
      if (p.style === 'star') {
        for (let trail = 2; trail > 0; trail--) star(p.x - Math.sign(p.vx) * trail * 16, ARENA.floor - p.y, 9 - trail * 2, .22 / trail);
        star(p.x, ARENA.floor - p.y, p.stage === 3 ? 18 : 14);
      } else { ctx.save(); ctx.shadowColor = '#8bdcf3'; ctx.shadowBlur = 14; ellipse(p.x, ARENA.floor - p.y, 31, 20, '#8ccbeacc'); ellipse(p.x - Math.sign(p.vx) * 15, ARENA.floor - p.y, 36, 12, '#bde7f388'); ctx.restore(); }
    }
    drawEffects(match.paused ? 0 : dt);
    if (match.phase === 'countdown') { ctx.fillStyle = '#7a5fa9'; ctx.textAlign = 'center'; ctx.font = '800 64px "Segoe UI",sans-serif'; ctx.fillText(match.countdown > .55 ? String(Math.ceil(match.countdown)) : '开打！', 600, 275); }
  } else {
    const positions = { niwa: 343, daodun: 600, whale: 862 };
    for (const spec of Object.values(ROSTER)) drawSprite({ id: spec.id, side: spec.id === selected ? 0 : 1, x: positions[spec.id], y: 0, action: 'idle', hp: spec.health, facing: 1, flash: 0 }, true);
    ctx.textAlign = 'center'; ctx.fillStyle = '#aa95be'; ctx.font = '9px "Segoe UI",sans-serif'; ctx.fillText('READY WHEN YOU ARE', 600, 290);
  }
  ctx.restore(); requestAnimationFrame(frame);
}
for (const spec of Object.values(ROSTER)) {
  const button = document.createElement('button'); button.type = 'button'; button.className = 'character-card'; button.dataset.character = spec.id; button.setAttribute('aria-pressed', spec.id === selected ? 'true' : 'false');
  const img = document.createElement('img'); img.src = spec.asset; img.alt = spec.name; img.draggable = false;
  const info = document.createElement('span'), name = document.createElement('h3'), role = document.createElement('span'), skill = document.createElement('div'), mark = document.createElement('span');
  name.textContent = spec.name; role.textContent = spec.subtitle; role.className = 'role'; skill.textContent = `✦ ${spec.skill}`; skill.className = 'skill'; mark.textContent = '✓'; mark.className = 'selection-mark';
  info.append(name, role, skill); button.append(img, info, mark); button.classList.toggle('selected', spec.id === selected); button.title = spec.description;
  button.addEventListener('click', () => { selected = spec.id; document.querySelectorAll('.character-card').forEach(el => { const isSelected = el.dataset.character === selected; el.classList.toggle('selected', isSelected); el.setAttribute('aria-pressed', String(isSelected)); }); });
  $('characters').append(button);
}
canvas.addEventListener('keydown', event => {
  const action = keyMap[event.code]; if (action) { event.preventDefault(); if (match && !match.paused && match.phase !== 'finished' && (!networked || $('overlay').hidden)) { inputs[action] = true; if (!event.repeat && tapActions.has(action)) queuedInputs[action] = true; notifyInput(); } }
  if (!event.repeat && event.code === 'Escape') { event.preventDefault(); if (networked ? !$('overlay').hidden : match?.paused) resumeGame(); else pauseGame(); }
  if (!event.repeat && event.code === 'KeyR' && match) { event.preventDefault(); startGame(); }
});
window.addEventListener('keyup', event => { const action = keyMap[event.code]; if (action) { inputs[action] = false; notifyInput(); } });
canvas.addEventListener('pointerdown', () => { if (match && !match.paused) canvas.focus({ preventScroll: true }); });
canvas.addEventListener('blur', clearInputs);
window.addEventListener('keydown', event => {
  if (event.target === canvas || !match || event.target.closest?.('input, select, textarea')) return;
  if (!event.repeat && event.code === 'Escape') { event.preventDefault(); if (networked ? !$('overlay').hidden : match.paused) resumeGame(); else pauseGame(); }
  if (!event.repeat && event.code === 'KeyR') { event.preventDefault(); startGame(); }
});
window.addEventListener('blur', () => { clearInputs(); if (!networked && match?.phase !== 'finished') pauseGame(); });
document.addEventListener('visibilitychange', () => { if (document.hidden) { clearInputs(); if (!networked) pauseGame(); audio?.suspend().catch(() => {}); } });
for (const button of document.querySelectorAll('[data-input]')) {
  const release = () => { inputs[button.dataset.input] = false; button.classList.remove('held'); notifyInput(); };
  button.addEventListener('pointerdown', event => { event.preventDefault(); if (!match || match.paused || match.phase !== 'playing') return; button.setPointerCapture(event.pointerId); inputs[button.dataset.input] = true; if (tapActions.has(button.dataset.input)) queuedInputs[button.dataset.input] = true; button.classList.add('held'); notifyInput(); });
  for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) button.addEventListener(name, release);
}
$('start').addEventListener('click', startGame); $('rematch').addEventListener('click', startGame); $('restart-top').addEventListener('click', startGame); $('pause').addEventListener('click', pauseGame); $('resume').addEventListener('click', resumeGame); $('change').addEventListener('click', lobby);
$('help').addEventListener('click', () => { $('guide-extra').hidden = !$('guide-extra').hidden; $('help').setAttribute('aria-expanded', String(!$('guide-extra').hidden)); });
$('sound').addEventListener('click', () => { soundOn = !soundOn; for (const voice of skillVoices.values()) voice.setEnabled(soundOn); $('sound').textContent = `音效：${soundOn ? '开' : '关'}`; $('sound').setAttribute('aria-pressed', String(soundOn)); if (soundOn) { audio ??= new AudioContext(); audio.resume().catch(() => {}); tone('block'); } else audio?.suspend().catch(() => {}); });
$('battle-mode').addEventListener('change', updateMode);
$('fight-code').addEventListener('input', () => { $('fight-code').value = $('fight-code').value.toUpperCase().replace(/\s/g,''); updateMode(); });
$('create-fight-code').addEventListener('click', () => requestOnline('create'));
$('cancel-online').addEventListener('click', lobby);
$('copy-fight-code').addEventListener('click', async () => { try { await navigator.clipboard.writeText($('room-code').textContent); $('online-message').textContent = '格斗码已复制，等待朋友加入'; } catch { $('online-message').textContent = '请手动选中并复制格斗码'; } });
try {
  await Promise.all([
    ...Object.values(ROSTER).map(async spec => { const image = new Image(); image.src = spec.asset; await image.decode(); images.set(spec.id, image); }),
    ...NIWA_LAUGH_FRAMES.map(async (src,index) => { const image=new Image();image.src=src;await image.decode();laughFrames[index]=prepareLaughFrame(image,document); }),
  ]);
  ready = true; $('loading').hidden = true; $('start').disabled = false;
} catch { $('loading').textContent = '角色图片没有完整加载。请使用项目内的启动命令打开，不会用其他角色替换。'; }
requestAnimationFrame(frame);
