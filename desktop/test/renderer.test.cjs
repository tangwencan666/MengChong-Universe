'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

// Renderer regression tests use a small DOM test double; Windows/native rendering
// and actual input are verified separately by the Electron acceptance suite.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const rendererSource = fs.readFileSync(path.join(__dirname, '../renderer/pet.js'), 'utf8');

class Element extends EventTarget {
  constructor(attributes = {}) {
    super();
    this.attributes = { ...attributes };
    this.dataset = {};
    this.textContent = '';
    this.disabled = true;
    this.capture = new Set();
    this.classes = new Set();
    this.classList = {
      toggle: (name, enabled) => enabled ? this.classes.add(name) : this.classes.delete(name),
    };
    this.properties = new Map();
    this.style = { setProperty: (name, value) => this.properties.set(name, value) };
  }
  setAttribute(name, value) { this.attributes[name] = value; }
  getAttribute(name) { return this.attributes[name] ?? null; }
  setPointerCapture(id) { this.capture.add(id); }
  hasPointerCapture(id) { return this.capture.has(id); }
  releasePointerCapture(id) { this.capture.delete(id); }
}

function renderHarness(initial = { pet_id: 'pet-a', name: '小叶', role_type: 'cat', state: 'idle', direction: 'right' }) {
  const document = new EventTarget();
  document.hidden = false;
  document.body = new Element();
  document.documentElement = new Element();
  const elements = new Map(['pet-hitbox', 'pet-art', 'pet-blink', 'pet-name', 'pet-bubble'].map((id) => [id, new Element()]));
  elements.get('pet-art').setAttribute('src', '/__assets/cloud.svg');
  document.getElementById = (id) => elements.get(id);
  const window = new EventTarget();
  const calls = [];
  let stateListener;
  let unsubscribeCount = 0;
  let resolveIdentity;
  const identity = new Promise((resolve) => { resolveIdentity = resolve; });
  const bridge = { identity: () => identity,
    onState: (callback) => { stateListener = callback; return () => { unsubscribeCount += 1; }; },
  };
  for (const method of ['dragStart', 'dragMove', 'dragEnd', 'chat', 'menu']) {
    bridge[method] = (...args) => { calls.push({ method, args }); return Promise.resolve(); };
  }
  window.weibiyePet = bridge;
  vm.runInNewContext(rendererSource, { window, document, AbortController, Promise });
  if (initial) resolveIdentity(initial);
  const dispatch = (target, name, properties = {}) => {
    const event = new Event(name, { cancelable: true });
    for (const [key, value] of Object.entries(properties)) Object.defineProperty(event, key, { value });
    target.dispatchEvent(event);
    return event;
  };
  return { window, document, elements, calls, dispatch,
    resolveIdentity, emit: (value) => stateListener(value), get unsubscribeCount() { return unsubscribeCount; },
  };
}

test('renderer whitelist, text-only names and immutable pet identity block content/path injection', async () => {
  const value = renderHarness({ pet_id: 'pet-a', name: '<img src=x onerror=alert(1)>',
    role_type: '../../outside', asset_id: 'https://outside/evil.svg', tint: 'url(outside)', state: 'unknown' });
  await Promise.resolve();
  assert.equal(value.elements.get('pet-name').textContent, '<img src=x onerror=alert(1)>');
  assert.equal(value.elements.get('pet-art').getAttribute('src'), '/__assets/cloud.svg');
  assert.equal(value.document.documentElement.properties.size, 0);
  assert.equal(value.document.body.dataset.state, 'idle');
  value.emit({ pet_id: 'pet-b', name: 'Another private pet', role_type: 'dog', state: 'walking' });
  assert.equal(value.document.body.dataset.petId, 'pet-a');
  assert.equal(value.document.body.dataset.state, 'idle');
  assert.equal(value.elements.get('pet-art').getAttribute('src'), '/__assets/cloud.svg');
});

test('four activity states use bounded text and cannot affect another renderer identity', async () => {
  const value = renderHarness(); await Promise.resolve();
  for (const activity of ['idle', 'happy', 'thinking', 'speaking']) {
    value.emit({ pet_id: 'pet-a', name: '月芽', role_type: 'cat', state: 'idle', activity });
    assert.equal(value.document.body.dataset.activity, activity);
  }
  value.emit({ pet_id: 'pet-a', activity: 'execute', greeting: '<script>local-text-only</script>' });
  assert.equal(value.document.body.dataset.activity, 'idle');
  assert.equal(value.elements.get('pet-bubble').textContent, '<script>local-text-only</script>');
  value.emit({ pet_id: 'pet-b', activity: 'thinking' });
  assert.equal(value.document.body.dataset.activity, 'idle');
});

test('only a host-selected DeepSeek preview loads the blink asset and receives pressed feedback', async () => {
  const selected = renderHarness({ pet_id: 'pet-a', name: '月芽', role_type: 'cat', asset_id: 'deepseek-local-preview', state: 'idle' });
  await Promise.resolve();
  assert.equal(selected.document.body.dataset.assetId, 'deepseek-local-preview');
  assert.equal(selected.elements.get('pet-art').getAttribute('src'), '/__assets/deepseek-open.png');
  assert.equal(selected.elements.get('pet-blink').getAttribute('src'), '/__assets/deepseek-blink.png');
  const button = selected.elements.get('pet-hitbox');
  selected.dispatch(button, 'pointerdown', { pointerId: 1, button: 0, screenX: 400, screenY: 300 });
  assert.equal(selected.document.body.dataset.feedback, 'pressed');
  selected.dispatch(button, 'pointercancel', { pointerId: 1 });
  assert.equal(selected.document.body.dataset.feedback, 'idle');
  assert.equal(selected.calls.filter((item) => item.method === 'chat').length, 0);
  for (const role of ['cat', 'dog', 'custom']) {
    const ordinary = renderHarness({ pet_id: 'ordinary', name: role, role_type: role, state: 'idle' });
    await Promise.resolve();
    const asset = role === 'custom' ? 'cloud' : role;
    assert.equal(ordinary.document.body.dataset.assetId, asset);
    assert.equal(ordinary.elements.get('pet-art').getAttribute('src'), '/__assets/' + asset + '.svg');
    assert.equal(ordinary.elements.get('pet-blink').getAttribute('src'), null);
    assert.equal(ordinary.document.body.dataset.feedback, undefined);
  }
});

test('renderer short click opens chat once, 6px drag and coalesced release never open chat', async () => {
  const value = renderHarness();
  await Promise.resolve();
  const button = value.elements.get('pet-hitbox');
  const pointer = (x, y, extra = {}) => ({ pointerId: 1, button: 0, screenX: x, screenY: y, ...extra });
  value.dispatch(button, 'pointerdown', pointer(400, 300));
  value.dispatch(button, 'pointermove', pointer(403, 302, { timeStamp: 40 }));
  value.dispatch(button, 'pointerup', pointer(403, 302));
  value.dispatch(button, 'click', { detail: 1 });
  assert.equal(value.calls.filter((call) => call.method === 'chat').length, 1);
  value.dispatch(button, 'pointerdown', pointer(400, 300));
  value.dispatch(button, 'pointermove', pointer(412, 300, { timeStamp: 80 }));
  value.dispatch(button, 'pointerup', pointer(415, 300));
  value.dispatch(button, 'click', { detail: 1 });
  assert.equal(value.calls.filter((call) => call.method === 'chat').length, 1);
  value.dispatch(button, 'pointerdown', pointer(400, 300));
  value.dispatch(button, 'pointerup', pointer(407, 300));
  assert.equal(value.calls.filter((call) => call.method === 'chat').length, 1);
  assert.equal(value.calls.filter((call) => call.method === 'dragEnd').length, 3);
  assert.ok(value.calls.filter((call) => call.method === 'dragMove').length >= 2);
});

test('renderer cancellation, native menu and keyboard activation have separate actions', async () => {
  const value = renderHarness();
  await Promise.resolve();
  const button = value.elements.get('pet-hitbox');
  value.dispatch(button, 'pointerdown', { pointerId: 1, button: 0, screenX: 400, screenY: 300 });
  value.dispatch(button, 'pointercancel', { pointerId: 1 });
  assert.equal(value.calls.filter((call) => call.method === 'chat').length, 0);
  assert.equal(value.dispatch(button, 'contextmenu').defaultPrevented, true);
  assert.equal(value.calls.filter((call) => call.method === 'menu').length, 1);
  value.dispatch(button, 'click', { detail: 0 });
  assert.equal(value.calls.filter((call) => call.method === 'chat').length, 1);
});

test('late initial identity cannot overwrite a new native state and cleanup unsubscribes', async () => {
  const value = renderHarness(null);
  value.emit({ pet_id: 'pet-a', name: '当前名字', role_type: 'dog', state: 'walking', direction: 'left' });
  value.resolveIdentity({ pet_id: 'pet-a', name: '旧名字', role_type: 'cat', state: 'idle' });
  await Promise.resolve();
  assert.equal(value.elements.get('pet-name').textContent, '当前名字');
  assert.equal(value.document.body.dataset.state, 'walking');
  assert.equal(value.document.body.dataset.direction, 'left');
  value.dispatch(value.window, 'pagehide');
  assert.equal(value.unsubscribeCount, 1);
  value.emit({ pet_id: 'pet-a', name: '已卸载', role_type: 'cat', state: 'idle' });
  assert.equal(value.elements.get('pet-name').textContent, '当前名字');
  value.dispatch(value.elements.get('pet-hitbox'), 'click', { detail: 0 });
  assert.equal(value.calls.length, 0);
});
