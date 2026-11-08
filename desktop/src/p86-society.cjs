'use strict';
const { createHash } = require('node:crypto');
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const SPECIES = ['moon', 'doubao', 'xiaoyun', 'maodie', 'hajimi', 'niwa', 'daodun', 'whale'];
const MOODS = ['happy', 'calm', 'curious', 'angry', 'upset', 'sad', 'shy', 'sleepy'];
const KINDS = ['greeting', 'play', 'cooperate', 'conflict', 'reconcile', 'rest', 'wander', 'observe', 'pet', 'comfort', 'feed', 'toy', 'blanket', 'mediate', 'support'];
const USER_ACTIONS = ['pet', 'comfort', 'chicken', 'fish', 'toy', 'blanket', 'mediate', 'support'];
const LIMITS = Object.freeze({ pets: 256, relations: 512, events: 200, ledger: 512, offlineMs: 900000, bytes: 1048576 });
const lines = { hello: ['你好呀，一起待会儿？', '路过，打个招呼。'], play: ['一起玩一小会儿！', '这个玩具很有趣。'], dispute: ['这个玩具我也想玩！', '等等，我们轮流好吗？'], mediate: ['先冷静一下，一起玩吧。', '我来当和事佬。'], upset: ['有点委屈，陪我一会儿就好。', '我休息一下，很快就好。'], peace: ['和好啦，下次轮流。', '刚才的小别扭过去啦。'], comfort: ['谢谢你陪着我。', '现在好多啦。'], feed: ['免费小点心，谢谢你！', '吃饱一点，心情也好一点。'], rest: ['小睡一下，醒来再玩。'], observe: ['看看伙伴们在做什么。'], wander: ['慢慢走一会儿。'], toy: ['免费玩具，一起玩吧！'], blanket: ['小毯子暖暖的。'] };
const voices = { moon: { hello: '月光正好，一起坐坐吧。', dispute: '我们慢慢商量，轮流好吗？' }, doubao: { hello: '汪！要一起玩一会儿吗？', upset: '想要一点陪伴，摇摇尾巴等你。' }, xiaoyun: { hello: '飘过来陪你一小会儿。', mediate: '小别扭吹散，慢慢来。' }, maodie: { dispute: '本猫也想玩，先排个队嘛！', comfort: '咳，本猫现在好多了。' }, hajimi: { upset: '有点委屈，陪陪我就好。', hello: '可以一起安静待着吗？' }, niwa: { observe: '它怎么动起来的？真想看看。', play: '发现新玩法啦，一起试试！' }, daodun: { dispute: '我们按顺序来，盾牌不参加争论。', mediate: '我来维持玩具小队的秩序。' }, whale: { mediate: '先冷静一下，我们轮流玩吧。', comfort: '谢谢你，心情像海水一样平静了。' } };
const privateDrivers = new WeakMap();
const clone = value => structuredClone(value), clamp = n => Math.max(0, Math.min(100, n));
function number(n) { return Number.isFinite(n) && n >= 0 && n < 1e15; }
function exact(value, names) { return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join('|') === names.split(' ').sort().join('|'); }
function initial(owner, seed, now) { return { version: 1, owner, revision: 1, counter: 0, rng: seed >>> 0 || 1, updated_at: now, next_decision: now + 15000, next_conflict: now + 120000, settings: { enabled: true, conflicts: true, bubbles: true, muted: false, frequency: 'normal', quiet_until: 0 }, pets: {}, relations: {}, events: [], ledger: [], active: null }; }
function validate(data, owner) {
    if (!UUID.test(owner) || !exact(data, 'version owner revision counter rng updated_at next_decision next_conflict settings pets relations events ledger active') || data.version !== 1 || data.owner !== owner || !Number.isSafeInteger(data.revision) || data.revision < 1 || !Number.isSafeInteger(data.counter) || data.counter < 0 || !Number.isInteger(data.rng) || data.rng < 1 || data.rng > 0xffffffff || ![data.updated_at, data.next_decision, data.next_conflict].every(number))
        throw Error('Invalid society snapshot');
    const s = data.settings;
    if (!exact(s, 'enabled conflicts bubbles muted frequency quiet_until') || ![s.enabled, s.conflicts, s.bubbles, s.muted].every(v => typeof v === 'boolean') || !['normal', 'rare'].includes(s.frequency) || !number(s.quiet_until))
        throw Error('Invalid society settings');
    if (!data.pets || Array.isArray(data.pets) || Object.keys(data.pets).length > LIMITS.pets || !data.relations || Array.isArray(data.relations) || Object.keys(data.relations).length > LIMITS.relations || !Array.isArray(data.events) || data.events.length > LIMITS.events || !Array.isArray(data.ledger) || data.ledger.length > LIMITS.ledger)
        throw Error('Society size limit');
    for (const [id, p] of Object.entries(data.pets)) {
        if (!UUID.test(id) || !exact(p, 'id species traits mood mood_until energy hunger boredom social updated_at cooldown conflict_after recent bubble') || p.id !== id || !SPECIES.includes(p.species) || !MOODS.includes(p.mood) || !exact(p.traits, 'playful sociable sensitive competitive') || !Object.values(p.traits).every(n => Number.isFinite(n) && n >= 0 && n <= 1) || ![p.energy, p.hunger, p.boredom, p.social].every(n => Number.isFinite(n) && n >= 0 && n <= 100) || ![p.updated_at, p.cooldown, p.conflict_after, p.mood_until].every(number) || !Array.isArray(p.recent) || p.recent.length > 8 || !p.recent.every(UUID.test.bind(UUID)))
            throw Error('Invalid pet state');
        if (p.bubble !== null && (!exact(p.bubble, 'code choice until event') || !lines[p.bubble.code] || !Number.isInteger(p.bubble.choice) || p.bubble.choice < 0 || p.bubble.choice > 10 || !number(p.bubble.until) || !UUID.test(p.bubble.event)))
            throw Error('Invalid local line');
    }
    for (const [key, r] of Object.entries(data.relations))
        if (!exact(r, 'pets affinity trust familiarity competition conflict_at cooperation_at alliance_until') || !Array.isArray(r.pets) || r.pets.length !== 2 || r.pets[0] >= r.pets[1] || key !== r.pets.join(':') || !r.pets.every(id => data.pets[id]) || ![r.affinity, r.trust, r.familiarity, r.competition].every(n => Number.isFinite(n) && n >= 0 && n <= 100) || ![r.conflict_at, r.cooperation_at, r.alliance_until].every(number))
            throw Error('Invalid relation');
    const seen = new Set();
    for (const e of data.events) {
        if (!exact(e, 'id kind participants started_at ended_at phase outcome user_actions relationship_changes visibility') || !UUID.test(e.id) || seen.has(e.id) || !KINDS.includes(e.kind) || !Array.isArray(e.participants) || e.participants.length < 1 || e.participants.length > 3 || new Set(e.participants).size !== e.participants.length || !e.participants.every(id => data.pets[id]) || !number(e.started_at) || (e.ended_at !== null && (!number(e.ended_at) || e.ended_at < e.started_at)) || !['approach', 'express', 'ended'].includes(e.phase) || !['pending', 'friendly', 'settled', 'withdrawn', 'interrupted', 'supported', 'comforted', 'used'].includes(e.outcome) || e.visibility !== 'participants' || !Array.isArray(e.user_actions) || e.user_actions.length > 8 || !Array.isArray(e.relationship_changes) || e.relationship_changes.length > 3)
            throw Error('Invalid shared event');
        seen.add(e.id);
        for (const a of e.user_actions)
            if (!exact(a, 'action pet at') || !USER_ACTIONS.includes(a.action) || !e.participants.includes(a.pet) || !number(a.at))
                throw Error('Invalid user action');
        for (const r of e.relationship_changes)
            if (!exact(r, 'pets affinity trust familiarity competition') || !Array.isArray(r.pets) || r.pets.length !== 2 || !r.pets.every(id => e.participants.includes(id)) || ![r.affinity, r.trust, r.familiarity, r.competition].every(n => Number.isFinite(n) && Math.abs(n) <= 100))
                throw Error('Invalid relation delta');
    }
    if (data.active !== null && !data.events.some(e => e.id === data.active && e.ended_at === null))
        throw Error('Missing active event');
    for (const l of data.ledger)
        if (!exact(l, 'request pet action revision at granted consumed source') || !UUID.test(l.request) || !data.pets[l.pet] || !USER_ACTIONS.includes(l.action) || !Number.isSafeInteger(l.revision) || l.revision < 1 || !number(l.at) || ![0, 1].includes(l.granted) || l.granted !== l.consumed || l.source !== 'local_free')
            throw Error('Invalid free interaction ledger');
    if (Buffer.byteLength(JSON.stringify(data)) > LIMITS.bytes)
        throw Error('Society byte limit');
    return data;
}
function createSociety({ owner, seed = 1, now = Date.now(), snapshot = null }) {
    if (!UUID.test(owner) || !number(now))
        throw Error('Invalid owner or clock');
    const data = snapshot ? clone(validate(snapshot, owner)) : initial(owner, seed, now), presence = new Map(), outbox = [];
    let stopped = false;
    const random = () => { let x = data.rng; x ^= x << 13; x ^= x >>> 17; x ^= x << 5; data.rng = x >>> 0 || 1; return data.rng / 4294967296; };
    const touch = at => { data.revision++; data.updated_at = Math.max(data.updated_at, at); };
    function id() { const raw = createHash('sha256').update(owner + ':' + (++data.counter)).digest('hex'); return raw.slice(0, 8) + '-' + raw.slice(8, 12) + '-4' + raw.slice(13, 16) + '-a' + raw.slice(17, 20) + '-' + raw.slice(20, 32); }
    function mood(p, value, at, duration = 60000) { p.mood = value; p.mood_until = at + duration; }
    function say(p, code, event, at) { p.bubble = { code, choice: Math.floor(random() * lines[code].length), until: at + 7000, event: event.id }; }
    function event(kind, ids, at) { const e = { id: id(), kind, participants: [...ids], started_at: at, ended_at: null, phase: 'approach', outcome: 'pending', user_actions: [], relationship_changes: [], visibility: 'participants' }; data.events.push(e); if (data.events.length > LIMITS.events) {
        const removed = data.events.shift();
        for (const p of Object.values(data.pets))
            p.recent = p.recent.filter(v => v !== removed.id);
    } for (const p of ids.map(v => data.pets[v]))
        p.recent = [e.id, ...p.recent].slice(0, 8); return e; }
    function relation(a, b) { const ids = [a, b].sort(), key = ids.join(':'); if (!data.relations[key]) {
        if (Object.keys(data.relations).length >= LIMITS.relations)
            return null;
        data.relations[key] = { pets: ids, affinity: 50, trust: 40, familiarity: 0, competition: 0, conflict_at: 0, cooperation_at: 0, alliance_until: 0 };
    } return data.relations[key]; }
    function change(e, a, b, delta, at) { const r = relation(a, b); if (!r)
        return; const applied = { pets: [a, b].sort(), affinity: 0, trust: 0, familiarity: 0, competition: 0 }; for (const key of ['affinity', 'trust', 'familiarity', 'competition']) {
        const old = r[key];
        r[key] = clamp(old + (delta[key] || 0));
        applied[key] = r[key] - old;
    } if (e.relationship_changes.length < 3)
        e.relationship_changes.push(applied); if (e.kind === 'conflict')
        r.conflict_at = at;
    else
        r.cooperation_at = at; }
    function end(e, at, outcome) { if (!e || e.ended_at !== null)
        return; e.ended_at = at; e.phase = 'ended'; e.outcome = outcome; if (data.active === e.id)
        data.active = null; data.next_decision = Math.max(data.next_decision, at + 25000); }
    function eligible() { return [...presence.entries()].filter(([key, p]) => data.pets[key] && p.visible && p.random && p.available).map(([key]) => key); }
    function nearby(a, b) { const p = presence.get(a), q = presence.get(b); return p && q && p.display === q.display && Math.hypot(p.x - q.x, p.y - q.y) <= 600; }
    function intent(p, action, toward = null) { outbox.push({ pet: p.id, action, toward }); }
    function start(kind, ids, at) {
        if (!data.settings.enabled || at < data.settings.quiet_until || data.active || !['greeting', 'play', 'cooperate', 'conflict', 'reconcile'].includes(kind) || ids.length < 2 || ids.length > 3 || new Set(ids).size !== ids.length || !ids.every(v => eligible().includes(v)) || ids.slice(1).some(v => !nearby(ids[0], v)))
            return false;
        if (kind === 'conflict' && (!data.settings.conflicts || ids.slice(0, 2).some(v => at < data.pets[v].conflict_after) || at < data.next_conflict))
            return false;
        const e = event(kind, ids, at);
        data.active = e.id;
        for (const pet of ids.map(v => data.pets[v])) {
            pet.cooldown = at + 45000;
            pet.social = clamp(pet.social - 20);
            if (kind === 'greeting')
                mood(pet, pet.traits.sociable < .5 ? 'shy' : 'curious', at, 20000);
            say(pet, kind === 'conflict' ? 'dispute' : kind === 'greeting' ? 'hello' : 'play', e, at);
            intent(pet, 'look', ids.find(v => v !== pet.id));
        }
        if (kind === 'conflict') {
            data.next_conflict = at + 720000;
            for (const key of ids.slice(0, 2))
                data.pets[key].conflict_after = at + 900000;
            if (ids[2])
                say(data.pets[ids[2]], 'mediate', e, at);
        }
        touch(at);
        return true;
    }
    function settle(e, at) {
        const [a, b, mediator] = e.participants.map(v => data.pets[v]);
        if (e.kind === 'conflict') {
            const loser = random() < (a.traits.sensitive / (a.traits.sensitive + b.traits.sensitive)) ? a : b;
            mood(loser, loser.traits.sensitive > .8 ? 'sad' : 'upset', at, 45000 + random() * 30000);
            say(loser, 'upset', e, at);
            mood(loser === a ? b : a, 'angry', at, 30000);
            change(e, a.id, b.id, { affinity: -3, trust: -1, familiarity: 3, competition: 5 }, at);
            if (mediator) {
                mood(mediator, 'calm', at);
                say(mediator, 'mediate', e, at);
                change(e, a.id, mediator.id, { affinity: 2, trust: 2, familiarity: 2 }, at);
                change(e, b.id, mediator.id, { affinity: 2, trust: 2, familiarity: 2 }, at);
            }
            end(e, at, 'settled');
        }
        else {
            for (const p of [a, b, ...(mediator ? [mediator] : [])]) {
                mood(p, 'happy', at);
                p.boredom = clamp(p.boredom - 18);
                intent(p, 'happy');
            }
            change(e, a.id, b.id, { affinity: 5, trust: 4, familiarity: 8, competition: -2 }, at);
            const r = relation(a.id, b.id);
            if (r && r.trust >= 44 && random() < .35)
                r.alliance_until = at + 120000;
            if (r && e.kind === 'reconcile') {
                r.conflict_at = 0;
                r.competition = Math.max(0, r.competition - 5);
                say(a, 'peace', e, at);
                say(b, 'peace', e, at);
            }
            if (mediator) {
                change(e, a.id, mediator.id, { affinity: 3, trust: 3, familiarity: 5 }, at);
                change(e, b.id, mediator.id, { affinity: 3, trust: 3, familiarity: 5 }, at);
                const s = relation(a.id, mediator.id);
                if (s)
                    s.alliance_until = at + 90000;
            }
            end(e, at, 'friendly');
        }
        touch(at);
    }
    function decay(at, resuming) {
        const gap = Math.max(0, at - data.updated_at), resume = resuming || gap > 300000;
        for (const p of Object.values(data.pets)) {
            const seconds = Math.min(LIMITS.offlineMs, Math.max(0, at - p.updated_at)) / 1000;
            p.energy = clamp(p.energy + (p.mood === 'sleepy' ? .06 : -.003) * seconds);
            p.hunger = clamp(p.hunger + .004 * seconds);
            p.boredom = clamp(p.boredom + .006 * seconds);
            p.social = clamp(p.social + .005 * seconds);
            p.updated_at = at;
            if (at >= p.mood_until && p.mood !== 'calm') {
                p.mood = 'calm';
                p.mood_until = 0;
            }
            if (p.bubble && at >= p.bubble.until)
                p.bubble = null;
        }
        for (const r of Object.values(data.relations)) {
            if (at >= r.alliance_until)
                r.alliance_until = 0;
            if (r.conflict_at && at - r.conflict_at >= 180000) {
                const dt = Math.min(LIMITS.offlineMs, gap) / 1000;
                r.competition = Math.max(0, r.competition - dt * .005);
                if (r.affinity < 50)
                    r.affinity = Math.min(50, r.affinity + dt * .001);
            }
        }
        if (resume) {
            end(data.events.find(e => e.id === data.active), at, 'interrupted');
            data.next_decision = at + 15000;
        }
        data.updated_at = at;
    }
    function advance(at, { background = false, resuming = false } = {}) {
        if (stopped)
            return [];
        at = Math.max(data.updated_at, at);
        if (!number(at))
            throw Error('Invalid clock');
        decay(at, resuming);
        const current = data.events.find(e => e.id === data.active);
        if (current) {
            if (current.participants.some(v => !eligible().includes(v)) || current.participants.slice(1).some(v => !nearby(current.participants[0], v)))
                end(current, at, 'withdrawn');
            else if (at - current.started_at >= 11000)
                settle(current, at);
            else if (current.phase === 'approach' && at - current.started_at >= 3000) {
                current.phase = 'express';
                for (const key of current.participants) {
                    const p = data.pets[key];
                    intent(p, current.kind === 'conflict' ? 'fluff' : 'happy', current.participants.find(v => v !== key));
                }
                touch(at);
            }
        }
        if (!data.active && at >= data.next_decision) {
            data.next_decision = at + (background ? 90000 : 25000) + (data.settings.frequency === 'rare' ? 60000 : 0) + random() * 20000;
            if (data.settings.enabled && at >= data.settings.quiet_until) {
                const candidates = eligible().filter(v => at >= data.pets[v].cooldown);
                if (candidates.length) {
                    const pick = candidates.map(v => ({ id: v, w: 1 + data.pets[v].boredom + data.pets[v].social })), total = pick.reduce((n, v) => n + v.w, 0);
                    let value = random() * total, chosen = pick[0].id;
                    for (const p of pick) {
                        value -= p.w;
                        if (value <= 0) {
                            chosen = p.id;
                            break;
                        }
                    }
                    const p = data.pets[chosen], others = candidates.filter(v => v !== chosen && nearby(chosen, v));
                    const peace = Object.values(data.relations).find(r => r.conflict_at && at - r.conflict_at >= 180000 && r.pets.includes(chosen) && r.pets.every(v => candidates.includes(v)) && nearby(...r.pets));
                    if (peace && random() < .5) {
                        start('reconcile', peace.pets, at);
                        touch(at);
                        return outbox.splice(0);
                    }
                    if (p.energy < 25) {
                        const e = event('rest', [chosen], at);
                        mood(p, 'sleepy', at, 90000);
                        say(p, 'rest', e, at);
                        intent(p, 'sleep');
                        p.cooldown = at + 90000;
                        end(e, at, 'friendly');
                    }
                    else if (others.length && random() < .65 + p.traits.sociable * .2 - p.hunger * .001) {
                        const ranked = others.map(v => ({ id: v, w: 1 + (relation(chosen, v)?.affinity ?? 50) + (relation(chosen, v)?.familiarity ?? 0) }));
                        let n = random() * ranked.reduce((a, b) => a + b.w, 0), other = ranked[0].id;
                        for (const q of ranked) {
                            n -= q.w;
                            if (n <= 0) {
                                other = q.id;
                                break;
                            }
                        }
                        const affinity = relation(chosen, other)?.affinity ?? 50;
                        if (affinity < 45 && random() < .25) {
                            const e = event('observe', [chosen], at);
                            say(p, 'observe', e, at);
                            intent(p, 'evade', other);
                            p.cooldown = at + 45000;
                            end(e, at, 'friendly');
                            touch(at);
                            return outbox.splice(0);
                        }
                        const kind = data.settings.conflicts && at >= data.next_conflict && at >= p.conflict_after && at >= data.pets[other].conflict_after && random() < .07 * (.5 + (p.traits.competitive + data.pets[other].traits.competitive) / 2) ? 'conflict' : random() < .25 ? 'cooperate' : random() < .5 ? 'greeting' : 'play';
                        const members = [chosen, other], third = others.filter(v => v !== other);
                        if (third.length && random() < .35)
                            members.push(third[Math.floor(random() * third.length)]);
                        start(kind, members, at);
                    }
                    else {
                        const kind = random() < .4 ? 'wander' : random() < .5 ? 'observe' : 'play', e = event(kind, [chosen], at);
                        mood(p, kind === 'play' ? 'happy' : 'curious', at, 30000);
                        say(p, kind === 'wander' ? 'wander' : kind === 'observe' ? 'observe' : 'play', e, at);
                        intent(p, kind === 'wander' ? 'walk' : kind === 'play' ? 'jump' : 'look');
                        p.boredom = clamp(p.boredom - 10);
                        p.cooldown = at + 30000;
                        end(e, at, 'friendly');
                    }
                }
            }
            touch(at);
        }
        return outbox.splice(0);
    }
    function ensure(p, at) {
        if (!UUID.test(p.id) || !SPECIES.includes(p.species))
            throw Error('Invalid pet identity');
        if (!data.pets[p.id]) {
            if (Object.keys(data.pets).length >= LIMITS.pets)
                throw Error('Local society pet limit');
            const traits = { playful: .3 + random() * .5, sociable: .3 + random() * .5, sensitive: .3 + random() * .5, competitive: .2 + random() * .4 };
            if (['maodie', 'niwa'].includes(p.species))
                traits.playful = Math.min(1, traits.playful + .2);
            if (['hajimi', 'whale'].includes(p.species)) {
                traits.sensitive = Math.min(1, traits.sensitive + .15);
                traits.competitive *= .6;
            }
            data.pets[p.id] = { id: p.id, species: p.species, traits, mood: 'calm', mood_until: 0, energy: 80, hunger: 15, boredom: 25, social: 35, updated_at: at, cooldown: at + 10000, conflict_after: 0, recent: [], bubble: null };
            touch(at);
        }
    }
    function setPresence(p, at) { if (stopped)
        return; ensure(p, at); presence.set(p.id, { visible: p.visible === true, available: p.available === true, random: p.random === true, autoMove: p.autoMove === true, display: p.display, x: p.x, y: p.y }); if (!p.visible || !p.available) {
        const e = data.events.find(v => v.id === data.active);
        if (e?.participants.includes(p.id))
            end(e, at, 'withdrawn');
    } }
    function own(requested) { if (requested !== owner)
        throw Error('Society owner mismatch'); }
    function interact(requested, pet, action, request, revision, at) {
        own(requested);
        if (stopped || !data.pets[pet] || !USER_ACTIONS.includes(action) || !UUID.test(request))
            throw Error('Invalid free interaction');
        const previous = data.ledger.find(v => v.request === request);
        if (previous) {
            if (previous.pet !== pet || previous.action !== action)
                throw Error('Idempotency conflict');
            return { duplicate: true, revision: data.revision };
        }
        if (revision !== data.revision)
            throw Error('Society version changed; refresh before trying again');
        const recent = data.ledger.findLast(v => v.pet === pet && v.action === action);
        if (recent && at - recent.at >= 0 && at - recent.at < 750)
            throw Error('Interaction cooldown');
        const p = data.pets[pet], active = data.events.find(v => v.id === data.active && v.participants.includes(pet));
        if (['mediate', 'support'].includes(action) && (!active || active.kind !== 'conflict'))
            throw Error('No active shared event');
        if (active) {
            active.user_actions.push({ action, pet, at });
            if (active.user_actions.length > 8)
                active.user_actions.shift();
            for (const key of active.participants) {
                mood(data.pets[key], key === pet ? 'happy' : 'calm', at, 45000);
                say(data.pets[key], 'peace', active, at);
            }
            if (active.participants.length >= 2)
                change(active, active.participants[0], active.participants[1], { affinity: 4, trust: 3, competition: -5 }, at);
            end(active, at, action === 'support' ? 'supported' : 'comforted');
        }
        const kind = ['chicken', 'fish'].includes(action) ? 'feed' : action, e = event(kind, [pet], at);
        e.user_actions.push({ action, pet, at });
        p.social = clamp(p.social - 15);
        p.boredom = clamp(p.boredom - 10);
        mood(p, 'happy', at, 45000);
        let code = 'comfort', motion = 'affection';
        if (kind === 'feed') {
            p.hunger = clamp(p.hunger - 35);
            p.energy = clamp(p.energy + 8);
            code = 'feed';
            motion = 'happy';
        }
        if (kind === 'toy') {
            p.boredom = clamp(p.boredom - 30);
            code = 'toy';
            motion = 'jump';
        }
        if (kind === 'blanket') {
            p.energy = clamp(p.energy + 10);
            code = 'blanket';
            motion = 'stretch';
        }
        say(p, code, e, at);
        intent(p, motion);
        end(e, at, 'used');
        touch(at);
        const item = ['chicken', 'fish', 'toy', 'blanket'].includes(action) ? 1 : 0;
        data.ledger.push({ request, pet, action, revision: data.revision, at, granted: item, consumed: item, source: 'local_free' });
        if (data.ledger.length > LIMITS.ledger)
            data.ledger.shift();
        return { duplicate: false, revision: data.revision };
    }
    function petView(p, at) { const shared = data.events.find(e => e.id === data.active && e.participants.includes(p.id)); return { id: p.id, species: p.species, mood: p.mood, needs: { energy: p.energy, hunger: p.hunger, boredom: p.boredom, social: p.social }, traits: clone(p.traits), cooldown_until: p.cooldown, current_event: shared?.id ?? null, partners: shared?.participants.filter(v => v !== p.id) ?? [], bubble: !data.settings.bubbles || data.settings.muted || at < data.settings.quiet_until || !p.bubble || at >= p.bubble.until ? null : { text: voices[p.species]?.[p.bubble.code] ?? lines[p.bubble.code][p.bubble.choice], until: p.bubble.until, event_id: p.bubble.event }, recent: [...p.recent] }; }
    function view(requested, at) { own(requested); return { owner_id: owner, at, revision: data.revision, settings: clone(data.settings), pets: Object.values(data.pets).map(p => petView(p, at)), relations: Object.values(data.relations).map(r => ({ ...clone(r), allied: r.alliance_until > at, friend: r.affinity >= 60 && r.trust >= 50 && r.familiarity >= 30 })), events: clone(data.events).reverse(), ledger: clone(data.ledger).reverse(), limits: LIMITS }; }
    const api = {
        owner, setPresence, advance, view,
        remove(pet, at) { presence.delete(pet); const e = data.events.find(v => v.id === data.active); if (e?.participants.includes(pet))
            end(e, at, 'withdrawn'); },
        pet(requested, pet, at) { own(requested); return data.pets[pet] ? petView(data.pets[pet], at) : null; },
        eventsFor(requested, pet) { own(requested); if (!data.pets[pet])
            throw Error('Unknown pet'); return clone(data.events.filter(e => e.participants.includes(pet))); },
        interact,
        autonomous(pet, at) { return at >= data.settings.quiet_until && (!data.active || !data.events.find(e => e.id === data.active)?.participants.includes(pet)); },
        configure(requested, patch, at) { own(requested); if (!patch || Array.isArray(patch) || Object.keys(patch).some(k => !['enabled', 'conflicts', 'bubbles', 'muted', 'frequency', 'quiet_until'].includes(k)) || patch.quiet_until > at + 600000)
            throw Error('Invalid settings'); const next = { ...data.settings, ...patch }, candidate = { ...clone(data), settings: next }; validate(candidate, owner); data.settings = next; data.next_decision = at + 15000; if (!next.enabled || (!next.conflicts && data.events.find(e => e.id === data.active)?.kind === 'conflict') || next.quiet_until > at) {
            end(data.events.find(e => e.id === data.active), at, 'interrupted');
            outbox.length = 0;
        } touch(at); },
        deleteEvent(requested, eventId, at) { own(requested); if (!UUID.test(eventId))
            throw Error('Invalid event'); data.events = data.events.filter(e => e.id !== eventId); if (data.active === eventId) {
            data.active = null;
            outbox.length = 0;
            data.next_decision = Math.max(data.next_decision, at + 25000);
        } for (const p of Object.values(data.pets)) {
            p.recent = p.recent.filter(v => v !== eventId);
            if (p.bubble?.event === eventId)
                p.bubble = null;
        } touch(at); },
        nextWake(at, background = false) { if (stopped || !presence.size)
            return null; const active = data.events.find(e => e.id === data.active), due = [at + (background ? 60000 : 30000)]; if (active)
            due.push(active.started_at + (active.phase === 'approach' ? 3000 : 11000));
        else
            due.push(data.next_decision); for (const p of Object.values(data.pets)) {
            if (p.bubble)
                due.push(p.bubble.until);
            if (p.mood_until > at)
                due.push(p.mood_until);
        } return Math.max(1000, Math.min(...due) - at); },
        export() { return clone(validate(data, owner)); },
        stop(at) { end(data.events.find(e => e.id === data.active), at, 'interrupted'); presence.clear(); outbox.length = 0; stopped = true; },
        get stopped() { return stopped; },
    };
    privateDrivers.set(api, (kind, ids, at, bypass) => { if (bypass && kind === 'conflict') {
        data.next_conflict = at;
        for (const key of ids.slice(0, 2))
            if (data.pets[key])
                data.pets[key].conflict_after = at;
    } return start(kind, ids, at); });
    return Object.freeze(api);
}
// Main-process acceptance only. Never included in renderer preload or UI routes.
function triggerForTest(engine, kind, ids, at, { bypassCooldown = false } = {}) { const driver = privateDrivers.get(engine); if (!driver)
    throw Error('Owned engine required'); return driver(kind, ids, at, bypassCooldown); }
module.exports = { createSociety, validate, triggerForTest, MOODS, SPECIES, LIMITS, USER_ACTIONS };
