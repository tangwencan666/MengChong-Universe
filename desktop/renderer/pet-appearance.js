'use strict';
// Pure public appearance mapping shared by the host and isolated renderer.
(function expose(root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports)
        module.exports = api;
    else
        Object.defineProperty(root, 'WeiBiYePetAppearance', { value: api });
})(globalThis, function create() {
    const ID = /^[a-z][a-z0-9-]{0,63}$/, SVG = /^[a-z0-9][a-z0-9-]{0,63}\.svg$/;
    const PNG = /^p85-[a-z0-9-]+-(?:front|side|back)(?:-reference)?-v[1-9][0-9]{0,2}\.png$/;
    function createCatalog(value) {
        if (value?.version !== 1 || !Array.isArray(value.appearances) || value.appearances.length < 1 || value.appearances.length > 60
            || !value.assets || Array.isArray(value.assets) || Object.keys(value.assets).length > 120)
            throw Error('Invalid appearance catalog');
        const assets = new Map(), appearances = new Map(), species = new Map();
        for (const [file, data] of Object.entries(value.assets)) {
            if (!PNG.test(file) || !data || !/^[a-f0-9]{64}$/.test(data.sha256) || !Number.isSafeInteger(data.bytes) || data.bytes < 24 || data.bytes > 131072
                || ![data.width, data.height].every(n => Number.isSafeInteger(n) && n > 0 && n <= 512) || typeof data.runtime !== 'boolean')
                throw Error('Invalid raster inventory');
            assets.set(file, Object.freeze({ ...data }));
        }
        for (const a of value.appearances) {
            if (!a || !ID.test(a.appearance_id) || !ID.test(a.species_id) || appearances.has(a.appearance_id) || !Number.isSafeInteger(a.asset_version) || a.asset_version < 1
                || !['local-raster', 'shipped-svg'].includes(a.kind) || !SVG.test(a.fallback_asset) || !Array.isArray(a.quality_notes) || a.quality_notes.length > 8
                || !a.quality_notes.every(n => typeof n === 'string' && n.length <= 240) || !a.references || Array.isArray(a.references)
                || Object.keys(a.references).some(k => !['front', 'side', 'back'].includes(k)) || ![null, 'left', 'right'].includes(a.side_facing))
                throw Error('Invalid appearance definition');
            if (a.kind === 'local-raster') {
                if (a.restriction !== 'local-verification-only' || a.animation_kind !== 'static-transform' || !assets.get(a.front_asset)?.runtime
                    || [a.side_asset, a.back_asset].some(f => f !== null && !assets.get(f)?.runtime)
                    || Object.values(a.references).some(f => !assets.has(f) || assets.get(f).runtime))
                    throw Error('Unreviewed local view');
            }
            else if (a.restriction !== 'shipped' || !SVG.test(a.front_asset) || a.side_asset !== null || a.back_asset !== null || Object.keys(a.references).length)
                throw Error('Invalid shipped appearance');
            const entry = Object.freeze({ ...a, references: Object.freeze({ ...a.references }), quality_notes: Object.freeze([...a.quality_notes]) });
            appearances.set(a.appearance_id, entry);
            if (!species.has(a.species_id))
                species.set(a.species_id, entry);
        }
        return Object.freeze({ list: () => [...appearances.values()], get: id => appearances.get(id), forSpecies: id => species.get(id), file: name => assets.get(name), files: () => [...assets.keys()], speciesFor: id => appearances.get(id)?.species_id });
    }
    function select(appearance, state) {
        if (!appearance || appearance.kind !== 'local-raster')
            return null;
        let requested = 'front', reason = null;
        if (state.action === 'turn')
            requested = 'back';
        else if (state.action === 'look')
            requested = 'side';
        else if (['walk', 'run', 'patrol', 'follow', 'evade'].includes(state.action)) {
            if (state.direction === appearance.side_facing)
                requested = 'side';
            else
                reason = 'missing-opposite-side';
        }
        const actual = appearance[requested + '_asset'] ? requested : 'front';
        if (actual !== requested)
            reason = appearance.references[requested] ? 'occluded-reference' : 'unavailable-view';
        return Object.freeze({ file: appearance[actual + '_asset'], view: actual, requested_view: requested, fallback_reason: reason, mirrored: false });
    }
    return Object.freeze({ createCatalog, select });
});
