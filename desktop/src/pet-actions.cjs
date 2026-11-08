'use strict';
// Pure, bounded, per-instance state machine. No animation timer, network or content.
const { registry } = require('./pet-registry.cjs');
const MOTION = new Set(['walk', 'run', 'follow', 'evade', 'patrol']);
const BLOCKED = new Set(['hidden', 'exited', 'dragging', 'thinking', 'speaking']);
function boundedRandom(random) { const value = random(); return Number.isFinite(value) ? Math.max(0, Math.min(.999999, value)) : .5; }
function createActor(definition, now, { random = Math.random, preferences = {} } = {}) {
    if (!registry.get(definition))
        throw Error('Unknown pet definition');
    return { definition, action: preferences.sleeping === true ? 'sleep' : 'idle', sequence: 1, until: preferences.sleeping === true ? now + 20000 : 0,
        priority: preferences.sleeping === true ? 15 : 0, lastNow: now, nextRandom: now + 30000 + boundedRandom(random) * 30000,
        nextMove: now + 90000 + boundedRandom(random) * 30000, nextPointer: now + 2500, lastClick: -Infinity, cooldowns: new Map(), random,
        preferences: { random: preferences.random !== false, autoMove: preferences.autoMove === true }, sleeping: preferences.sleeping === true, disposed: false, motion: null };
}
function start(actor, action, now, { direct = false } = {}) {
    if (actor.disposed || !registry.hasAction(action))
        return false;
    now = Math.max(actor.lastNow, now);
    actor.lastNow = now;
    const spec = registry.action(action), priority = direct ? 90 : spec.priority;
    if (BLOCKED.has(action))
        throw Error('Reserved state must be driven by host');
    if (actor.action === action || priority < actor.priority || (!direct && (actor.cooldowns.get(action) ?? 0) > now))
        return false;
    if (direct && now - actor.lastClick < 600)
        return false;
    if (direct)
        actor.lastClick = now;
    actor.action = action;
    actor.priority = priority;
    actor.until = now + spec.duration;
    actor.sequence++;
    actor.sleeping = action === 'sleep';
    actor.cooldowns.set(action, now + spec.cooldown);
    actor.motion = null;
    return true;
}
function force(actor, action, now) {
    if (actor.action !== action) {
        actor.action = action;
        actor.sequence++;
        actor.motion = null;
    }
    actor.priority = registry.action(action).priority;
    actor.until = now + registry.action(action).duration;
    if (!['hidden', 'exited', 'sleep'].includes(action))
        actor.sleeping = false;
}
function tick(actor, now, { hidden = false, dragging = false, activity = 'idle', near = false, canMove = false, reducedMotion = false, autonomous = true } = {}) {
    if (actor.disposed)
        return view(actor);
    now = Math.max(actor.lastNow, now);
    actor.lastNow = now;
    if (hidden)
        force(actor, 'hidden', now);
    else if (dragging)
        force(actor, 'dragging', now);
    else {
        if (['hidden', 'dragging'].includes(actor.action))
            force(actor, actor.sleeping ? 'sleep' : 'idle', now);
        if (actor.until && now >= actor.until) {
            const previous = actor.action;
            force(actor, 'idle', now);
            if (previous === 'sleep')
                start(actor, 'wake', now);
        }
        if (['thinking', 'speaking'].includes(activity) && actor.priority <= registry.action(activity).priority)
            force(actor, activity, now);
        else if (['thinking', 'speaking'].includes(actor.action))
            force(actor, 'idle', now);
        if (activity === 'happy' && actor.action === 'idle')
            start(actor, 'happy', now);
        if (reducedMotion && actor.priority < 90)
            force(actor, 'idle', now);
        const definition = registry.get(actor.definition);
        if (autonomous && !reducedMotion && near && actor.preferences.random && now >= actor.nextPointer && actor.priority < 40) {
            actor.nextPointer = now + 30000;
            start(actor, definition.pointer, now);
        }
        if (autonomous && !reducedMotion && actor.preferences.random && actor.action === 'idle' && now >= actor.nextRandom) {
            actor.nextRandom = now + 35000 + boundedRandom(actor.random) * 40000;
            const choices = definition.random;
            start(actor, choices[Math.floor(boundedRandom(actor.random) * choices.length)], now);
        }
        if (autonomous && !reducedMotion && actor.preferences.autoMove && canMove && !near && actor.action === 'idle' && now >= actor.nextMove) {
            actor.nextMove = now + 90000 + boundedRandom(actor.random) * 60000;
            start(actor, definition.movement, now);
        }
    }
    return view(actor);
}
function configure(actor, value) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['random', 'autoMove'].includes(key))
        || !Object.keys(value).length || Object.values(value).some(v => typeof v !== 'boolean'))
        throw Error('Invalid pet preferences');
    Object.assign(actor.preferences, value);
    if (!actor.preferences.random && !BLOCKED.has(actor.action) || !actor.preferences.autoMove && MOTION.has(actor.action))
        force(actor, 'idle', actor.lastNow);
    return saved(actor);
}
function view(actor) { return { action: actor.action, action_sequence: actor.sequence, action_label: registry.action(actor.action).label }; }
function saved(actor) { return { ...actor.preferences, sleeping: actor.sleeping }; }
function dispose(actor) { actor.disposed = true; actor.motion = null; actor.cooldowns.clear(); force(actor, 'exited', actor.lastNow); }
module.exports = { createActor, start, tick, configure, view, saved, dispose, MOTION, BLOCKED };
