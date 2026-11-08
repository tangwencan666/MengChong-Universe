'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), vm = require('node:vm'), fs = require('node:fs'), path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../renderer/pet-action-view.js'), 'utf8');
const manifest = require('../assets/pet-definitions.json');
class Element extends EventTarget {
    constructor() { super(); this.dataset = {}; this.attributes = {}; this.textContent = ''; }
    setAttribute(k, v) { this.attributes[k] = v; }
    getAttribute(k) { return this.attributes[k] ?? null; }
    removeAttribute(k) { delete this.attributes[k]; }
}
async function renderer(body = manifest) {
    const document = new EventTarget(), window = new EventTarget(), elements = new Map(['pet-art', 'pet-blink', 'pet-bubble'].map(id => [id, new Element()]));
    document.hidden = false;
    document.body = new Element();
    document.getElementById = id => elements.get(id);
    window.WeiBiYePetCatalog = body;
    vm.runInNewContext(source, { document, window, AbortController });
    await new Promise(setImmediate);
    return { document, window, elements, apply: window.weibiyePetActions.apply };
}
const identity = (changes = {}) => ({ pet_id: 'own-pet', definition_id: 'maodie', role_type: 'cat', action: 'idle', action_sequence: 1, ...changes });
test('renderer maps only registered assets and ignores older sequences and other pet identities', async () => {
    const value = await renderer();
    assert.equal(value.apply(identity()), true);
    assert.equal(value.elements.get('pet-art').getAttribute('src'), '/__assets/p84-maodie.svg');
    value.apply(identity({ action: 'blink', action_sequence: 2 }));
    assert.equal(value.elements.get('pet-art').getAttribute('src'), '/__assets/p84-maodie-blink.svg');
    value.apply(identity());
    value.apply(identity({ pet_id: 'other', definition_id: 'hajimi', action_sequence: 99 }));
    assert.equal(value.document.body.dataset.action, 'blink');
});
test('hidden and disposed renderers release images and stop late asynchronous updates', async () => {
    const value = await renderer();
    value.apply(identity());
    value.document.hidden = true;
    value.document.dispatchEvent(new Event('visibilitychange'));
    assert.equal(value.elements.get('pet-art').getAttribute('src'), null);
    value.elements.get('pet-art').dispatchEvent(new Event('error'));
    assert.equal(value.elements.get('pet-art').getAttribute('src'), null);
    value.document.hidden = false;
    value.document.dispatchEvent(new Event('visibilitychange'));
    assert.equal(value.elements.get('pet-art').getAttribute('src'), '/__assets/p84-maodie.svg');
    value.apply(identity({ action: 'hidden', action_sequence: 3 }));
    assert.equal(value.apply(identity({ action_sequence: 2 })), true);
    assert.equal(value.elements.get('pet-art').getAttribute('src'), null);
    value.window.dispatchEvent(new Event('pagehide'));
    assert.equal(value.apply(identity({ action_sequence: 2 })), false);
    assert.equal(value.elements.get('pet-art').getAttribute('src'), null);
});
test('invalid catalog paths cannot become an image request and missing frames use a bounded fallback', async () => {
    const bad = structuredClone(manifest);
    bad.pets[0].assets.idle = 'https://outside/secret.svg';
    const invalid = await renderer(bad);
    assert.equal(invalid.apply(identity()), false);
    assert.equal(invalid.elements.get('pet-art').getAttribute('src'), null);
    const value = await renderer();
    value.apply(identity({ action: 'blink' }));
    value.elements.get('pet-art').dispatchEvent(new Event('error'));
    assert.equal(value.elements.get('pet-art').getAttribute('src'), '/__assets/p84-maodie.svg');
});
