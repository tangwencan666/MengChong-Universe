'use strict';
(() => {
    const art = document.getElementById('pet-art'), blink = document.getElementById('pet-blink'), bubble = document.getElementById('pet-bubble');
    const controller = new AbortController();
    let definitions, knownActions, appearances, latest, petId, sequence = -1, disposed = false, failed = 0;
    const unavailable=new Set();
    function release() { art.removeAttribute('src'); blink?.removeAttribute('src'); document.body.dataset.action = 'hidden'; }
    function apply(value) {
        if (disposed || !value || typeof value.pet_id !== 'string' || petId && petId !== value.pet_id)
            return false;
        if (value.asset_id === 'deepseek-local-preview')
            return false;
        const next = value.action_sequence;
        if (!Number.isSafeInteger(next) || next < 0)
            return false;
        if (next < sequence)
            return true; // Stale presentation cannot reload a hidden image.
        petId = value.pet_id;
        sequence = next;
        latest = value;
        if (document.hidden || value.action === 'hidden') {
            release();
            return true;
        }
        const definition = definitions?.get(value.definition_id);
        if (!definition)
            return false;
        const action = knownActions.has(value.action) ? value.action : 'idle';
        document.body.dataset.action = action;
        document.body.dataset.actionSequence = String(next);
        document.body.dataset.definition = definition.id;
        let file = action === 'sleep' ? definition.assets.sleep : action === 'blink' ? definition.assets.blink : definition.assets.idle;
        const appearance=appearances?.get(value.appearance_id)??appearances?.forSpecies(definition.id);
        const frame=appearance?.species_id===definition.id?window.WeiBiYePetAppearance?.select(appearance,value):null;
        document.body.dataset.raster=frame?'local-static':'none';
        document.body.dataset.appearance=appearance?.appearance_id??'';
        document.body.dataset.view=frame?.view??'front';
        document.body.dataset.requestedView=frame?.requested_view??'front';
        document.body.dataset.viewFallback=frame?.fallback_reason??'';
        document.body.dataset.resourceFallback='false';
        if(frame){
            file=frame.file;
            if(unavailable.has(file)){file=unavailable.has(appearance.front_asset)?appearance.fallback_asset:appearance.front_asset;document.body.dataset.resourceFallback='true';document.body.dataset.view='front';}
        }
        const resource = '/__assets/' + file;
        if (art.getAttribute('src') !== resource)
            art.setAttribute('src', resource);
        if (typeof value.action_label === 'string' && value.action_label.length <= 60 && action !== 'idle')
            bubble.textContent = value.action_label;
        return true;
    }
    art.addEventListener('error', () => {
        if (document.hidden || latest?.action === 'hidden') {
            release();
            return;
        }
        if (disposed || !latest || failed++ > 1)
            return;
        const current=art.getAttribute('src');
        if(current?.startsWith('/__assets/p85-')&&unavailable.size<16){
            unavailable.add(current.slice('/__assets/'.length));
            failed=0;apply(latest);return;
        }
        const definition = definitions?.get(latest.definition_id);
        const fallback = failed === 1 ? definition?.assets.idle : { cat: 'cat.svg', dog: 'dog.svg', custom: 'cloud.svg' }[latest.role_type];
        if (fallback)
            art.setAttribute('src', '/__assets/' + fallback);
        document.body.dataset.action = 'idle';
    }, { signal: controller.signal });
    document.addEventListener('visibilitychange', () => {
        if (document.hidden)
            release();
        else if (latest)
            apply(latest);
    }, { signal: controller.signal });
    window.addEventListener('pagehide', () => { disposed = true; controller.abort(); release(); definitions?.clear();unavailable.clear(); }, { once: true });
    window.weibiyePetActions = Object.freeze({ apply });
    try {
        const body = window.WeiBiYePetCatalog;
        if (body.version !== 1 || !Array.isArray(body.pets) || body.pets.length > 30 || !body.actions)
            throw Error('Invalid registry');
        const candidates = new Map();
        for (const item of body.pets) {
            if (!/^[a-z][a-z0-9-]{0,39}$/.test(item.id) || candidates.has(item.id)
                || Object.keys(item.assets ?? {}).sort().join('|') !== 'blink|idle|sleep'
                || !Object.values(item.assets).every(file => typeof file === 'string' && /^[a-z0-9][a-z0-9-]{0,63}\.svg$/.test(file)))
                throw Error('Invalid resource map');
            candidates.set(item.id, item);
        }
        if (disposed)
            return;
        definitions = candidates;
        if(body.appearances&&window.WeiBiYePetAppearance)appearances=window.WeiBiYePetAppearance.createCatalog(body.appearances);
        knownActions = new Set(Object.keys(body.actions));
        if (latest)
            apply(latest);
    }
    catch { /* Safe fallback to the existing shipped role image. */ }
})();
