'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), fsp = require('node:fs/promises'), path = require('node:path'), os = require('node:os'), vm = require('node:vm'), { createHash } = require('node:crypto');
const { registry, createRegistry } = require('../src/pet-registry.cjs'), actions = require('../src/pet-actions.cjs');
const { createCatalog, select } = require('../renderer/pet-appearance.js');
const { registerAppearanceAssets, BUDGET } = require('../src/p85-appearance-assets.cjs');
const definitions = require('../assets/pet-definitions.json'), documentManifest = require('../assets/p85-appearances.json');
const catalog = createCatalog(documentManifest);
test('eight species and appearance aliases retain all five original assets; configured display limit stays validated', () => {
    assert.equal(registry.list().length, 8);
    assert.equal(registry.maxVisible, 5);
    for (const id of ['moon', 'doubao', 'xiaoyun', 'maodie', 'hajimi'])
        assert.equal(catalog.forSpecies(id).kind, 'shipped-svg');
    for (const id of ['niwa', 'daodun', 'whale']) {
        assert.equal(registry.resolve(id + '-source-v1', 'custom').id, id);
        assert.equal(registry.appearance(id + '-source-v1', 'custom').species_id, id);
        assert.equal(catalog.forSpecies(id).restriction, 'local-verification-only');
    }
    const lower = structuredClone(definitions);
    lower.desktop.visible_limit = 3;
    assert.equal(createRegistry(lower).maxVisible, 3);
    for (const bad of [0, 6, Infinity, '5']) {
        const value = structuredClone(definitions);
        value.desktop.visible_limit = bad;
        assert.throws(() => createRegistry(value));
    }
});
test('only real clean source angles are selected; missing directions never mirror the sword or invent a back', () => {
    const niwa = catalog.forSpecies('niwa'), knight = catalog.forSpecies('daodun'), whale = catalog.forSpecies('whale');
    assert.equal(select(niwa, { action: 'idle' }).view, 'front');
    assert.equal(select(niwa, { action: 'look' }).view, 'side');
    assert.equal(select(niwa, { action: 'turn' }).view, 'back');
    assert.equal(select(knight, { action: 'patrol', direction: 'left' }).view, 'side');
    assert.equal(select(knight, { action: 'patrol', direction: 'right' }).fallback_reason, 'missing-opposite-side');
    for (const role of [knight, whale])
        assert.equal(select(role, { action: 'turn' }).fallback_reason, 'occluded-reference');
    assert.equal(select(whale, { action: 'look' }).view, 'front');
    assert.equal(select(whale, { action: 'blink' }).file, whale.front_asset);
    assert.ok([niwa, knight, whale].every(role => !select(role, { action: 'turn' }).mirrored));
});
test('unregistered paths, malformed hashes and contaminated runtime views are refused', () => {
    for (const mutate of [d => { d.appearances[5].front_asset = 'https://outside/image.png'; }, d => { d.appearances[5].back_asset = d.appearances[6].references.back; }, d => { d.assets[Object.keys(d.assets)[0]].sha256 = 'fake'; }, d => { d.appearances[7].restriction = 'public'; }, d => { d.appearances[5].front_asset = '../../personal.png'; }]) {
        const value = structuredClone(documentManifest);
        mutate(value);
        assert.throws(() => createCatalog(value));
    }
});
test('new finite actions keep cooldowns, AI/drag priority and sibling state independent', () => {
    for (const [species, action] of [['niwa', 'sway'], ['daodun', 'guard'], ['daodun', 'patrol'], ['whale', 'wave']]) {
        const one = actions.createActor(species, 0), two = actions.createActor(species, 0);
        assert.equal(actions.start(one, action, 1000), true);
        assert.equal(two.action, 'idle');
        const spec = registry.action(action);
        actions.tick(one, 1000 + spec.duration + 1);
        assert.equal(actions.start(one, action, 1000 + spec.duration + 2), false);
        assert.equal(actions.tick(one, 200000, { activity: 'thinking' }).action, 'thinking');
        assert.equal(actions.tick(one, 200010, { dragging: true }).action, 'dragging');
        actions.dispose(one);
        assert.equal(actions.start(one, action, 999999), false);
        assert.equal(two.action, 'idle');
    }
});
class Element extends EventTarget {
    constructor() { super(); this.dataset = {}; this.attributes = {}; this.textContent = ''; }
    setAttribute(k, v) { this.attributes[k] = v; }
    getAttribute(k) { return this.attributes[k] ?? null; }
    removeAttribute(k) { delete this.attributes[k]; }
}
function renderer() {
    const document = new EventTarget(), window = new EventTarget(), art = new Element();
    document.hidden = false;
    document.body = new Element();
    const elements = { 'pet-art': art, 'pet-blink': new Element(), 'pet-bubble': new Element() };
    document.getElementById = id => elements[id];
    window.WeiBiYePetCatalog = { ...definitions, appearances: documentManifest };
    window.WeiBiYePetAppearance = { createCatalog, select };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../renderer/pet-action-view.js'), 'utf8'), { document, window, AbortController });
    return { document, window, art, apply: window.weibiyePetActions.apply };
}
const identity = (change = {}) => ({ pet_id: 'own-instance', definition_id: 'niwa', appearance_id: 'niwa-source-v1', role_type: 'custom', action: 'idle', action_sequence: 1, ...change });
test('isolated raster renderer changes real directions and releases hidden images without late or foreign revival', () => {
    const r = renderer();
    r.apply(identity({ action: 'turn', action_sequence: 2 }));
    assert.equal(r.art.getAttribute('src'), '/__assets/p85-niwa-back-v1.png');
    r.apply(identity({ pet_id: 'other-instance', definition_id: 'whale', action_sequence: 99 }));
    assert.equal(r.document.body.dataset.view, 'back');
    r.apply(identity({ action: 'hidden', action_sequence: 3 }));
    assert.equal(r.art.getAttribute('src'), null);
    r.art.dispatchEvent(new Event('error'));
    r.apply(identity({ action_sequence: 2 }));
    assert.equal(r.art.getAttribute('src'), null);
    r.apply(identity({ action_sequence: 4 }));
    assert.equal(r.art.getAttribute('src'), '/__assets/p85-niwa-front-v1.png');
    r.window.dispatchEvent(new Event('pagehide'));
    assert.equal(r.art.getAttribute('src'), null);
    assert.equal(r.apply(identity({ action_sequence: 5 })), false);
});
test('raster failures try one clean front then the declared SVG and do not keep retrying unavailable pictures', () => {
    const r = renderer();
    r.apply(identity({ action: 'turn', action_sequence: 2 }));
    r.art.dispatchEvent(new Event('error'));
    assert.equal(r.art.getAttribute('src'), '/__assets/p85-niwa-front-v1.png');
    assert.equal(r.document.body.dataset.resourceFallback, 'true');
    r.art.dispatchEvent(new Event('error'));
    assert.equal(r.art.getAttribute('src'), '/__assets/cloud.svg');
    r.apply(identity({ action: 'turn', action_sequence: 3 }));
    assert.equal(r.art.getAttribute('src'), '/__assets/cloud.svg');
});
function crc32(bytes) { let c = 0xffffffff; for (const n of bytes) {
    c ^= n;
    for (let b = 0; b < 8; b++)
        c = (c >>> 1) ^ ((c & 1) ? 0xedb88320 : 0);
} return (c ^ 0xffffffff) >>> 0; }
function paddedPng() {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1EAAAAASUVORK5CYII=', 'base64');
    const payload = Buffer.from('note\0' + 'x'.repeat(60000)), body = Buffer.concat([Buffer.from('tEXt'), payload]), length = Buffer.alloc(4), crc = Buffer.alloc(4);
    length.writeUInt32BE(payload.length);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([png.subarray(0, -12), length, body, crc, png.subarray(-12)]);
}
test('local PNG cache verifies content, deduplicates reads, evicts within budget and clears on exit', async (t) => {
    const rootTask = await fsp.mkdtemp(path.join(os.tmpdir(), 'p85-eight-cache-'));
    t.after(async () => { assert.equal(await fsp.realpath(rootTask), rootTask); assert.equal(path.dirname(rootTask), os.tmpdir()); await fsp.rm(rootTask, { recursive: true }); });
    const folder = path.join(rootTask, 'local-preview/p85-eight-v1');
    await fsp.mkdir(folder, { recursive: true });
    const data = paddedPng(), meta = { ...structuredClone(documentManifest), appearances: [], assets: {} };
    for (let i = 0; i < 6; i++) {
        const name = `p85-fixture${i}-front-v1.png`;
        await fsp.writeFile(path.join(folder, name), data);
        meta.assets[name] = { sha256: createHash('sha256').update(data).digest('hex'), bytes: data.length, width: 1, height: 1, runtime: true };
        meta.appearances.push({ ...structuredClone(documentManifest.appearances[5]), appearance_id: `fixture${i}-v1`, species_id: `fixture${i}`, front_asset: name, side_asset: null, back_asset: null, references: {} });
    }
    const resources = new Map(), cache = await registerAppearanceAssets(rootTask, resources, { catalog: createCatalog(meta) });
    assert.equal(cache.stats.bytes, 0);
    assert.equal(cache.stats.loads, 0);
    const resource = resources.get('/__assets/p85-fixture0-front-v1.png');
    const [one, two] = await Promise.all([resource.read(), resource.read()]);
    assert.equal(one, two);
    assert.equal(cache.stats.loads, 1);
    for (const resource of resources.values())
        await resource.read();
    assert.ok(cache.stats.bytes <= BUDGET);
    assert.ok(cache.stats.entries < resources.size);
    const corrupt = Buffer.from(data);
    corrupt[32] ^= 1;
    await fsp.writeFile(path.join(folder, 'p85-fixture0-front-v1.png'), corrupt);
    await assert.rejects(resource.read());
    assert.equal(cache.stats.rejected, 1);
    cache.close();
    assert.equal(cache.stats.bytes, 0);
    await assert.rejects(resource.read());
});
test('missing local-only artwork keeps the original app usable without exposing an arbitrary file route', async () => {
    const resources = new Map(), cache = await registerAppearanceAssets(path.join(__dirname, 'fixtures/no-local-eight-assets'), resources);
    assert.equal(cache.stats.available, false);
    assert.equal(resources.size, 0);
    assert.equal(cache.stats.bytes, 0);
    cache.close();
});
