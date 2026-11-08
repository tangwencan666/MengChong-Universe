'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createSociety, triggerForTest, validate, LIMITS } = require('../src/p86-society.cjs');
const { createSocietyStore } = require('../src/p86-store.cjs');
const OWNER = '10000000-0000-4000-8000-000000000001', OTHER = '20000000-0000-4000-8000-000000000002';
const IDS = [1, 2, 3, 4, 5].map(n => '30000000-0000-4000-8000-' + String(n).padStart(12, '0'));
const KEY = '40000000-0000-4000-8000-000000000001';
function engine(seed = 19) { const e = createSociety({ owner: OWNER, seed, now: 1000 }); for (const [i, id] of IDS.entries())
    e.setPresence({ id, species: i < 3 ? 'hajimi' : 'maodie', visible: true, available: true, random: true, autoMove: true, display: 1, x: i * 100, y: 0 }, 1000); return e; }
test('seeded state and decisions replay exactly; species never supplies instance identity', () => { const a = engine(), b = engine(); for (let at = 1000; at < 600000; at += 1000)
    assert.deepEqual(a.advance(at), b.advance(at)); assert.deepEqual(a.export(), b.export()); assert.notDeepEqual(a.export().pets[IDS[0]].traits, a.export().pets[IDS[1]].traits); assert.notDeepEqual(engine(20).export(), engine(19).export()); });
test('friendly actual events update only participating relations and can form finite alliances', () => { const e = engine(); for (let i = 0; i < 12; i++) {
    const at = 1000 + i * 60000;
    assert.equal(triggerForTest(e, 'cooperate', IDS.slice(0, 3), at), true);
    e.advance(at + 11000);
} const s = e.view(OWNER, 672000); assert.ok(s.relations.some(r => r.friend)); assert.ok(s.relations.every(r => r.pets.every(id => IDS.slice(0, 3).includes(id)))); assert.ok(s.relations.some(r => r.alliance_until > 0)); e.advance(1000000); assert.ok(e.view(OWNER, 1000000).relations.every(r => !r.allied)); });
test('conflict has two disputants, optional mediator, per-pet/global cooldown and natural emotional recovery', () => { const e = engine(); assert.equal(triggerForTest(e, 'conflict', IDS.slice(0, 3), 1000), false); assert.equal(triggerForTest(e, 'conflict', IDS.slice(0, 3), 121000), true); e.advance(132000); assert.equal(e.view(OWNER, 132000).events[0].kind, 'conflict'); const upset = e.view(OWNER, 132000).pets.filter(p => ['upset', 'sad'].includes(p.mood)); assert.equal(upset.length, 1); assert.ok(IDS.slice(0, 2).includes(upset[0].id)); assert.equal(triggerForTest(e, 'conflict', IDS.slice(0, 2), 140000), false); e.configure(OWNER, { enabled: false }, 140000); e.advance(220000); assert.ok(e.view(OWNER, 220000).pets.every(p => !['angry', 'upset', 'sad'].includes(p.mood))); });
test('comfort is always free and food atomically grants/consumes one item with replay protection', () => { const e = engine(); triggerForTest(e, 'conflict', IDS.slice(0, 2), 121000); e.advance(132000); let revision = e.view(OWNER, 132000).revision; e.interact(OWNER, IDS[0], 'chicken', KEY, revision, 133000); const first = e.export(); assert.equal(first.ledger[0].consumed, 1); assert.equal(first.ledger[0].granted, 1); assert.equal(first.ledger[0].source, 'local_free'); assert.equal(e.interact(OWNER, IDS[0], 'chicken', KEY, revision, 134000).duplicate, true); assert.deepEqual(e.export(), first); assert.throws(() => e.interact(OWNER, IDS[1], 'chicken', KEY, revision, 134000), /Idempotency/); assert.throws(() => e.interact(OWNER, IDS[0], 'fish', KEY.replace(/1$/, '2'), revision, 134000), /version/); e.interact(OWNER, IDS[0], 'comfort', KEY.replace(/1$/, '3'), first.revision, 134000); assert.equal(e.export().ledger[1].consumed, 0); });
test('user mediation records only real choices and changes a live event, not a fabricated story', () => { const e = engine(); assert.throws(() => e.interact(OWNER, IDS[0], 'mediate', KEY, e.export().revision, 1000), /No active/); triggerForTest(e, 'conflict', IDS.slice(0, 3), 121000); e.interact(OWNER, IDS[0], 'mediate', KEY, e.export().revision, 122000); const shared = e.eventsFor(OWNER, IDS[1]).find(v => v.kind === 'conflict'); assert.deepEqual(shared.user_actions, [{ action: 'mediate', pet: IDS[0], at: 122000 }]); assert.equal(shared.outcome, 'comforted'); assert.ok(shared.relationship_changes[0].trust > 0); });
test('same-species nonparticipants and other owners cannot read shared events; deletion removes all participant references', () => { const e = engine(); triggerForTest(e, 'play', IDS.slice(0, 2), 1000); const id = e.eventsFor(OWNER, IDS[0])[0].id; assert.equal(e.eventsFor(OWNER, IDS[2]).length, 0); assert.throws(() => e.eventsFor(OTHER, IDS[0]), /owner/); e.deleteEvent(OWNER, id, 2000); assert.equal(e.eventsFor(OWNER, IDS[0]).length, 0); assert.equal(e.export().active, null); assert.ok(e.view(OWNER, 2000).pets.every(p => !p.recent.includes(id) && p.bubble === null)); });
test('hidden/recalled/AI-busy pets withdraw from events and cannot be picked for a new event', () => { const e = engine(); triggerForTest(e, 'play', IDS.slice(0, 2), 1000); e.setPresence({ id: IDS[0], species: 'hajimi', visible: false }, 2000); assert.equal(e.export().active, null); assert.equal(e.eventsFor(OWNER, IDS[0])[0].outcome, 'withdrawn'); assert.equal(triggerForTest(e, 'play', IDS.slice(0, 2), 3000), false); e.remove(IDS[1], 3000); assert.equal(triggerForTest(e, 'play', IDS.slice(1, 3), 4000), false); });
test('quiet, conflict switch, muted lines and bubble expiry preserve bounded safe state', () => { const e = engine(); e.configure(OWNER, { conflicts: false, bubbles: false }, 1000); assert.equal(triggerForTest(e, 'conflict', IDS.slice(0, 2), 121000), false); triggerForTest(e, 'play', IDS.slice(0, 2), 121000); assert.equal(e.pet(OWNER, IDS[0], 121000).bubble, null); e.configure(OWNER, { quiet_until: 122000 + 600000 }, 122000); e.advance(150000); assert.equal(e.export().active, null); assert.equal(e.autonomous(IDS[0], 150000), false); assert.throws(() => e.configure(OWNER, { quiet_until: 1e14 }, 150000)); e.configure(OWNER, { quiet_until: 0, bubbles: true }, 151000); triggerForTest(e, 'play', IDS.slice(0, 2), 152000); assert.ok(e.pet(OWNER, IDS[0], 152000).bubble); assert.equal(e.pet(OWNER, IDS[0], 160000).bubble, null); });
test('offline settlement is capped, does not replay missed events, and stop cancels future work', () => { const e = engine(); const before = e.export(), later = 1000 + 10 * 86400000; e.advance(later); const after = e.export(); assert.ok(after.pets[IDS[0]].hunger - before.pets[IDS[0]].hunger <= LIMITS.offlineMs / 1000 * .004 + .001); assert.equal(after.events.length, 0); assert.ok(after.next_decision > later); e.stop(later); assert.equal(e.nextWake(later), null); assert.deepEqual(e.advance(later + 600000), []); });
test('natural conflict admission stays below friendly events and does not target one pet repeatedly', () => { let friendly = 0, conflicts = 0; for (let seed = 1; seed <= 20; seed++) {
    const e = engine(seed);
    for (let at = 1000; at < 3600000; at += 1000)
        e.advance(at);
    for (const v of e.export().events) {
        if (v.kind === 'conflict')
            conflicts++;
        else if (v.participants.length >= 2)
            friendly++;
    }
    assert.ok(e.export().events.length <= LIMITS.events);
    assert.ok(Object.keys(e.export().relations).length <= 10);
} assert.ok(conflicts > 0); assert.ok(conflicts < friendly / 3); });
test('snapshot validation rejects private/freeform fields, cross-owner substitution and out-of-range needs', () => { const e = engine(), s = e.export(); validate(s, OWNER); for (const alter of [d => d.chat = 'private', d => d.owner = OTHER, d => d.pets[IDS[0]].energy = 1000, d => d.settings.frequency = 'continuous', d => d.ledger.push({ body: 'private' })]) {
    const bad = structuredClone(s);
    alter(bad);
    assert.throws(() => validate(bad, OWNER));
} });
test('atomic owner stores restore relations and event ledger; corrupt data is retained without overwrite', t => { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'p86-store-')); t.after(() => { assert.equal(fs.realpathSync(root), root); assert.equal(path.dirname(root), os.tmpdir()); fs.rmSync(root, { recursive: true }); }); const store = createSocietyStore(root), e = engine(); triggerForTest(e, 'play', IDS.slice(0, 2), 1000); e.advance(12000); store.save(OWNER, e.export()); assert.deepEqual(createSocietyStore(root).load(OWNER), e.export()); assert.equal(store.load(OTHER), null); const file = path.join(root, 'pet-society-v1', fs.readdirSync(path.join(root, 'pet-society-v1'))[0]); fs.writeFileSync(file, 'invalid-json'); const broken = createSocietyStore(root); assert.equal(broken.load(OWNER), null); assert.equal(broken.healthy, false); assert.equal(broken.save(OWNER, e.export()), false); assert.equal(fs.readFileSync(file, 'utf8'), 'invalid-json'); });
test('expired idempotency ledger entries still cannot replay a stale version', () => { const e = engine(); let version = e.export().revision; const original = version; for (let i = 0; i < 515; i++) {
    const key = '40000000-0000-4000-8000-' + String(i + 1).padStart(12, '0');
    version = e.interact(OWNER, IDS[0], 'chicken', key, version, 1000 + i * 1000).revision;
} assert.equal(e.export().ledger.length, 512); assert.equal(e.export().events.length, 200); assert.throws(() => e.interact(OWNER, IDS[0], 'chicken', KEY, original, 900000), /version/); });
test('natural reconciliation follows actual conflict and is not a fabricated user choice', () => { let found = false; for (let seed = 1; seed <= 12 && !found; seed++) {
    const e = engine(seed);
    triggerForTest(e, 'conflict', IDS.slice(0, 2), 121000);
    e.advance(132000);
    for (let at = 133000; at < 900000; at += 1000)
        e.advance(at);
    const events = e.export().events.filter(v => v.kind === 'reconcile');
    if (events.length) {
        found = true;
        assert.ok(events.every(v => v.user_actions.length === 0));
    }
} assert.equal(found, true); });

test('a normal sixty-second background wake does not reset the decision clock as offline recovery',()=>{const e=engine();e.configure(OWNER,{enabled:false},1000);e.advance(16000,{background:true});const next=e.export().next_decision;e.advance(76001,{background:true});assert.equal(e.export().next_decision,next);});
test('explicit short sleep recovery ends an unfinished event without inventing a negative outcome',()=>{const e=engine();triggerForTest(e,'conflict',IDS.slice(0,2),121000);e.advance(166000,{resuming:true,background:true});assert.equal(e.eventsFor(OWNER,IDS[0])[0].outcome,'interrupted');assert.ok(e.view(OWNER,166000).pets.every(p=>!['upset','angry'].includes(p.mood)));});

test('cross-display movement withdraws a shared event without inventing cooperation',()=>{const e=engine();triggerForTest(e,'play',IDS.slice(0,2),1000);e.setPresence({id:IDS[1],species:'hajimi',visible:true,available:true,random:true,autoMove:true,display:2,x:100,y:0},2000);e.advance(4000);assert.equal(e.eventsFor(OWNER,IDS[0])[0].outcome,'withdrawn');assert.equal(e.view(OWNER,4000).relations.length,0);});
test('disabling conflicts or changing bubble preferences preserves an ongoing friendly event',()=>{const e=engine();triggerForTest(e,'play',IDS.slice(0,2),1000);const id=e.export().active;e.configure(OWNER,{conflicts:false},2000);e.configure(OWNER,{bubbles:false},3000);assert.equal(e.export().active,id);assert.throws(()=>e.interact(OWNER,IDS[0],'mediate',KEY,e.export().revision,4000),/No active/);e.advance(12000);assert.equal(e.eventsFor(OWNER,IDS[0])[0].outcome,'friendly');});
test('sensitive and reserved instances have bounded sad/shy reactions without permanent punishment',()=>{let sad=false,shy=false;for(let seed=1;seed<=50&&!(sad&&shy);seed++){const e=engine(seed);triggerForTest(e,'greeting',IDS.slice(0,2),1000);shy ||=e.view(OWNER,1000).pets.some(p=>p.mood==='shy');e.advance(12000);triggerForTest(e,'conflict',IDS.slice(0,2),121000);e.advance(132000);sad ||=e.view(OWNER,132000).pets.some(p=>p.mood==='sad');e.configure(OWNER,{enabled:false},133000);e.advance(220000);assert.ok(e.view(OWNER,220000).pets.every(p=>!['sad','shy','upset','angry'].includes(p.mood)));}assert.equal(sad,true);assert.equal(shy,true);});

test('low-energy instances rest and wake with finite sleep mood and bounded recovery',()=>{const original=engine(),snap=original.export();Object.values(snap.pets).forEach(p=>p.energy=10);const e=createSociety({owner:OWNER,seed:19,now:1000,snapshot:snap});IDS.forEach((id,i)=>e.setPresence({id,species:i<3?'hajimi':'maodie',visible:true,available:true,random:true,display:1,x:i*100,y:0},1000));const intents=e.advance(16000);const rest=e.view(OWNER,16000).events.find(v=>v.kind==='rest');assert.ok(rest);assert.ok(intents.some(v=>v.action==='sleep'));assert.equal(e.pet(OWNER,rest.participants[0],16000).mood,'sleepy');e.configure(OWNER,{enabled:false},17000);e.advance(107000);const p=e.pet(OWNER,rest.participants[0],107000);assert.equal(p.mood,'calm');assert.ok(p.needs.energy>10&&p.needs.energy<25);});
