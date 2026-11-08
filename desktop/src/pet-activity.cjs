'use strict';

const { UUID } = require('./policy.cjs');
const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
const GENERATION = new Set(['queued', 'running', 'cancel_requested', ...TERMINAL]);
const GREETING_INTERVAL = 30 * 60 * 1000;
const GREETINGS = Object.freeze({ cat: '我在这里，休息一下也很好。', dog: '见到你真开心，想聊聊就点我。', custom: '抬头放松一下，我会安静陪着你。' });

function createActivity(now) {
  return { state: 'idle', until: 0, generation: null, retired: [], greeting: '', greetingUntil: 0, nextGreeting: now + GREETING_INTERVAL };
}

function applySignal(activity, signal, now) {
  if (!signal || Object.keys(signal).sort().join('|') !== 'generation_id|has_output|sequence|session_id|state'
    || !UUID.test(signal.generation_id ?? '') || !UUID.test(signal.session_id ?? '')
    || !GENERATION.has(signal.state) || typeof signal.has_output !== 'boolean'
    || !Number.isSafeInteger(signal.sequence) || signal.sequence < 0 || signal.sequence > 1000000) throw new TypeError('Invalid activity signal');
  const current = activity.generation;
  if (activity.retired.includes(signal.generation_id)) return false;
  if (current?.generation_id === signal.generation_id) {
    if (current.session_id !== signal.session_id || current.sequence > signal.sequence || TERMINAL.has(current.state)) return false;
  } else if (current) {
    activity.retired.push(current.generation_id);
    activity.retired = activity.retired.slice(-32);
  }
  activity.generation = { ...signal };
  activity.greeting = ''; activity.greetingUntil = 0;
  activity.state = signal.state === 'completed' ? 'happy' : TERMINAL.has(signal.state) ? 'idle'
    : signal.has_output ? 'speaking' : 'thinking';
  activity.until = TERMINAL.has(signal.state) ? now + 2500 : now + 180000;
  return true;
}

function greet(activity, role, now) {
  if (['thinking', 'speaking'].includes(activity.state)) return false;
  activity.greeting = GREETINGS[role] ?? GREETINGS.custom;
  activity.greetingUntil = now + 6000;
  activity.nextGreeting = now + GREETING_INTERVAL;
  activity.state = 'happy'; activity.until = now + 6000;
  return true;
}

function view(activity, now) {
  if (now >= activity.until) activity.state = 'idle';
  if (now >= activity.greetingUntil) activity.greeting = '';
  return { activity: activity.state, ...(activity.greeting ? { greeting: activity.greeting } : {}) };
}

module.exports = { createActivity, applySignal, greet, view, GREETING_INTERVAL };
