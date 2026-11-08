'use strict';
const manifest = require('../assets/pet-definitions.json');
const { createCatalog } = require('../renderer/pet-appearance.js');
const appearances = createCatalog(require('../assets/p85-appearances.json'));
const ID = /^[a-z][a-z0-9-]{0,39}$/;
const SVG = /^[a-z0-9][a-z0-9-]{0,63}\.svg$/;
function createRegistry(input) {
    const limit=input?.desktop?.visible_limit??5;
    if(!Number.isSafeInteger(limit)||limit<1||limit>5||(input?.desktop&&input.desktop.validated_max!==5))throw Error('Unverified desktop limit');
    if (input?.version !== 1 || !Array.isArray(input.pets) || input.pets.length < 1 || input.pets.length > 30
        || !input.actions || Object.keys(input.actions).length > 50)
        throw Error('Invalid pet registry');
    const actions = new Map(), pets = new Map();
    for (const [id, value] of Object.entries(input.actions)) {
        if (!ID.test(id) || !Number.isInteger(value.priority) || value.priority < 0 || value.priority > 120
            || !Number.isInteger(value.duration) || value.duration < 0 || value.duration > 180000
            || !Number.isInteger(value.cooldown) || value.cooldown < 0 || value.cooldown > 600000
            || typeof value.label !== 'string' || value.label.length > 60)
            throw Error('Invalid action definition');
        actions.set(id, Object.freeze({ ...value }));
    }
    const reserved = new Set(['idle', 'thinking', 'speaking', 'dragging', 'hidden', 'exited']);
    if ([...reserved].some(id => !actions.has(id)) || actions.get('idle').duration !== 0 || actions.get('thinking').priority <= 90
        || !(actions.get('exited').priority > actions.get('hidden').priority
            && actions.get('hidden').priority > actions.get('dragging').priority
            && actions.get('dragging').priority > actions.get('speaking').priority
            && actions.get('thinking').priority === actions.get('speaking').priority)
        || [...actions].some(([id, value]) => !reserved.has(id) && (value.priority > 60 || value.duration > 30000)))
        throw Error('Invalid action priority contract');
    for (const item of input.pets) {
        if (!ID.test(item.id) || pets.has(item.id) || typeof item.name !== 'string' || !item.name || item.name.length > 60
            || !['cat', 'dog', 'custom'].includes(item.role_type) || !['calm', 'playful', 'warm'].includes(item.tone)
            || !/^#[a-f0-9]{6}$/i.test(item.tint) || typeof item.persona !== 'string' || item.persona.length > 600
            || typeof item.greeting !== 'string' || item.greeting.length > 60
            || Object.keys(item.assets ?? {}).sort().join('|') !== 'blink|idle|sleep'
            || !Object.values(item.assets).every(file => SVG.test(file)) || !Array.isArray(item.random) || item.random.length > 12
            || !Array.isArray(item.menu) || item.menu.length > 12 || !['walk', 'run', 'patrol'].includes(item.movement)
            || ![...item.random, ...item.menu, item.click, item.pointer].every(id => actions.has(id) && !reserved.has(id)))
            throw Error('Invalid pet definition');
        pets.set(item.id, Object.freeze({ ...item, assets: Object.freeze({ ...item.assets }), random: Object.freeze([...item.random]), menu: Object.freeze([...item.menu]) }));
    }
    return Object.freeze({
        list: () => [...pets.values()], maxVisible:limit, action: id => actions.get(id) ?? actions.get('idle'),
        hasAction: id => actions.has(id), get: id => pets.get(id),
        resolve: (asset, role) => pets.get(asset) ?? pets.get(appearances.speciesFor(asset)) ?? pets.get({ cat: 'moon', dog: 'doubao', custom: 'xiaoyun' }[role]) ?? pets.values().next().value,
        appearance:(asset,role)=>appearances.get(asset)??appearances.forSpecies(pets.has(asset)?asset:({cat:'moon',dog:'doubao',custom:'xiaoyun'}[role])),
        assetFiles: () => [...new Set([...pets.values()].flatMap(item => Object.values(item.assets)))],
    });
}
module.exports = { createRegistry, registry: createRegistry(manifest) };
