'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs/promises'), path = require('node:path');
module.exports = async function socialChecks(ctx) {
    const { check, inspect, until, native, petPage, quit, launch, page, target, ids, run, result, delay, host } = ctx;
    const owner = target.accounts[0].owner_id;
    const configure = patch => page().evaluate(({ owner, patch }) => window.weibiyeDesktop.socialSettings(owner, patch), { owner, patch });
    const view = () => inspect('society');
    let members, friendlyId, upset, feedKey, relationSnapshot;
    await check('P86 five instances create actual shared cooperation, move safely and update independent relations', async () => {
        console.log('PACE before P86 local social checks');
        await delay(65000);
        await configure({ enabled: false, conflicts: true, bubbles: true, muted: false, frequency: 'rare', quiet_until: 0 });
        // The old lifecycle fixture deliberately packs windows at the minimum gap.
        // Create real free space by dragging, without bypassing collision checks.
        const packed = await inspect('stats'), moved = packed.pets.find(p => p.id === ids[1]);
        const display = packed.displays.find(d => moved.bounds.x >= d.workArea.x && moved.bounds.x < d.workArea.x + d.workArea.width);
        assert.ok(display && display.workArea.width >= 1100 && display.workArea.height >= 700, 'Social desktop fixture needs a sufficiently large tested display');
        await native('native-interaction.ps1', ['-WindowHandle', moved.handle, '-ExpectedProcessId', String(host()), '-Action', 'drag', '-DeltaY', String(Math.round((display.workArea.y + 80 - moved.bounds.y) * display.scaleFactor)), '-HitTestTimeoutMs', '1000']);
        const raised = (await inspect('stats')).pets.find(p => p.id === ids[1]);
        await native('native-interaction.ps1', ['-WindowHandle', moved.handle, '-ExpectedProcessId', String(host()), '-Action', 'drag', '-DeltaX', String(Math.round((display.workArea.x + 320 - raised.bounds.x) * display.scaleFactor)), '-HitTestTimeoutMs', '1000']);
        await configure({ enabled: true });
        for (const id of ids)
            await inspect('configure', { id, preferences: { random: true, autoMove: true } });
        await inspect('society-ready');
        const before = await inspect('stats'), group = before.pets;
        outer: for (const first of group)
            for (const second of group)
                for (const third of group) {
                    if (new Set([first.id, second.id, third.id]).size !== 3)
                        continue;
                    if ([second, third].every(p => Math.hypot(first.bounds.x - p.bounds.x, first.bounds.y - p.bounds.y) < 550)) {
                        members = [first.id, second.id, third.id];
                        break outer;
                    }
                }
        assert.ok(members, 'No safe nearby three-instance group');
        assert.equal(await inspect('society-trigger', { kind: 'cooperate', ids: members }), true);
        const cooperationId = (await view()).pets.find(p => p.id === members[0]).current_event;
        await until(async () => (await view()).events.some(e => e.id === cooperationId && e.ended_at && e.outcome === 'friendly'), 'Actual cooperation did not finish');
        const s = await view(), event = s.events.find(e => e.id === cooperationId);
        friendlyId = event.id;
        assert.equal(event.user_actions.length, 0);
        assert.ok(event.relationship_changes.length >= 1);
        assert.ok(s.relations.some(r => r.pets.every(id => members.includes(id)) && r.familiarity > 0));
        const after = await inspect('stats');
        result.socialApproachEvidence = { before, after };
        assert.ok(after.actions.coordinatedMoves > before.actions.coordinatedMoves, 'No social approach was admitted by the collision guard');
        assert.ok(after.pets.some(p => { const old = before.pets.find(q => q.id === p.id); return Math.hypot(p.bounds.x - old.bounds.x, p.bounds.y - old.bounds.y) > 2; }));
        const outsider = ids.find(id => !members.includes(id)), privateView = await (await petPage(outsider)).evaluate(() => window.weibiyePet.sharedEvents());
        assert.ok(privateView.every(e => e.participants.includes(outsider)));
        assert.ok(!privateView.some(e => e.id === friendlyId));
        await page().getByText('查看伙伴关系', { exact: true }).click();
        await page().screenshot({ path: path.join(run, 'social-relations.png') });
        return { members, eventId: friendlyId, relationshipChanges: event.relationship_changes, physicalMovement: true, nonparticipantDenied: true, trigger: 'privileged acceptance-only, not an ordinary user control' };
    });
    await check('P86 bounded local conflict resolves and one real pet window displays temporary upset without facial asset edits', async () => {
        await inspect('society-ready');
        assert.equal(await inspect('society-trigger', { kind: 'conflict', ids: members }), true);
        const conflictId = (await view()).pets.find(p => p.id === members[0]).current_event;
        await until(async () => (await view()).events.some(e => e.id === conflictId && e.ended_at && e.outcome === 'settled'), 'Controlled conflict did not resolve');
        const s = await view(), event = s.events.find(e => e.id === conflictId);
        upset = event.participants.slice(0, 2).find(id => s.pets.find(p => p.id === id)?.mood && ['upset', 'sad'].includes(s.pets.find(p => p.id === id).mood));
        assert.ok(upset);
        const sprite = await petPage(upset);
        await until(() => sprite.locator('body').getAttribute('data-mood').then(v => ['upset', 'sad'].includes(v)), 'Mood did not reach actual renderer');
        assert.ok((await sprite.locator('#pet-name').evaluate(el => getComputedStyle(el, '::before').content)).includes('💧'));
        await sprite.screenshot({ path: path.join(run, 'social-upset.png') });
        return { eventId: event.id, upset, kind: event.kind, endedAt: event.ended_at, publicUiMarker: 'tear beside name; original facial pixels unchanged', controlledCooldownBypass: true };
    });
    await check('P86 real pet click opens its chat; user comfort and free chicken persist exactly one local item use', async () => {
        const pet = (await inspect('stats')).pets.find(p => p.id === upset);
        await native('native-interaction.ps1', ['-WindowHandle', pet.handle, '-ExpectedProcessId', String(host()), '-Action', 'click', '-HitTestTimeoutMs', '1000']);
        await until(async () => (await inspect('stats')).pets.find(p => p.id === upset)?.chatURL?.includes('/pets/' + upset), 'Pet click did not open its own chat');
        const summary = page().getByText('查看心情与免费互动', { exact: true });
        await summary.click();
        const card = page().locator(`[data-social-pet="${upset}"]`);
        await card.getByRole('button', { name: '免费安慰', exact: true }).click();
        await until(async () => (await view()).pets.find(p => p.id === upset).mood === 'happy', 'Comfort did not restore mood');
        const before = await view(), count = before.ledger.filter(l => l.action === 'chicken').length;
        await card.getByRole('button', { name: '免费鸡腿', exact: true }).dblclick();
        await until(async () => (await view()).ledger.filter(l => l.action === 'chicken').length === count + 1, 'Food use not recorded');
        const fed = await view(), entry = fed.ledger.find(l => l.action === 'chicken');
        feedKey = entry.request;
        const retry = await page().evaluate(({ owner, entry }) => window.weibiyeDesktop.socialAction(owner, entry.pet, 'chicken', entry.request, 1), { owner, entry });
        assert.equal(retry.state.ledger.filter(l => l.action === 'chicken').length, count + 1);
        assert.equal(entry.granted, 1);
        assert.equal(entry.consumed, 1);
        assert.equal(entry.source, 'local_free');
        assert.ok(fed.pets.find(p => p.id === upset).needs.hunger < before.pets.find(p => p.id === upset).needs.hunger);
        await page().screenshot({ path: path.join(run, 'social-free-care.png') });
        return { pet: upset, physicalClick: true, comfort: true, feedKey, granted: 1, consumed: 1, paidBalance: false, doubleClickAndRetryDuplicateConsumption: false };
    });
    await check('P86 owner intervention, event deletion, quiet/conflict settings and hidden/recall lifecycle remain scoped', async () => {
        await until(async () => (await inspect('stats')).pets.filter(p => members.includes(p.id)).every(p => p.priority < 90), 'Direct user interaction did not settle before the next controlled event');
        await inspect('society-ready');
        assert.equal(await inspect('society-trigger', { kind: 'conflict', ids: members }), true);
        const mediationId = (await view()).pets.find(p => p.id === members[0]).current_event;
        const card = page().locator(`[data-social-pet="${members[0]}"]`);
        await card.getByRole('button', { name: '调解当前事件', exact: true }).click();
        await until(async () => (await view()).events.some(e => e.id === mediationId && e.user_actions.some(a => a.action === 'mediate')), 'User mediation missing');
        await configure({ conflicts: false });
        assert.equal(await inspect('society-trigger', { kind: 'conflict', ids: members }), false);
        await page().getByRole('button', { name: '全部安静十分钟', exact: true }).click();
        await until(async () => (await view()).settings.quiet_until > Date.now(), 'Quiet choice not applied');
        assert.equal(await inspect('society-trigger', { kind: 'play', ids: members }), false);
        await page().getByRole('button', { name: '恢复自主活动', exact: true }).click();
        await configure({ conflicts: true });
        await page().getByRole('button', { name: '查看共同事件', exact: true }).click();
        await page().locator(`[data-social-event="${friendlyId}"]`).getByRole('button', { name: '删除这条事件', exact: true }).click();
        await page().getByRole('button', { name: '确认删除此事件', exact: true }).click();
        await until(async () => !(await view()).events.some(e => e.id === friendlyId), 'Deleted shared event reappeared');
        for (const id of members) {
            const events = await (await petPage(id)).evaluate(() => window.weibiyePet.sharedEvents());
            assert.ok(!events.some(e => e.id === friendlyId));
        }
        for (const id of ids) {
            await inspect('close-chat', id);
            await inspect('hide', id);
        }
        assert.equal((await inspect('stats')).society.pending, false);
        for (const id of ids)
            await inspect('show', id);
        assert.equal((await inspect('stats')).society.pending, true);
        await page().getByRole('button', { name: '一键收回全部', exact: true }).click();
        await until(async () => (await inspect('stats')).pets.length === 0, 'Recall did not release society actors');
        assert.equal((await inspect('stats')).society.pending, false);
        await page().getByRole('button', { name: '恢复上次桌面组合', exact: true }).click();
        await until(async () => (await inspect('stats')).pets.length === 5 && await page().getByRole('button', {name:'一键收回全部',exact:true}).isEnabled(), 'Combination restore has not finished');
        await inspect('society-sync');
        return { actualMediation: true, deleted: friendlyId, participantsNoLongerReadDeleted: true, quiet: true, conflictsSwitch: true, allHiddenAndRecalledTimeouts: 0 };
    });
    await check('P86 normal process restart restores relationship values and actual user event/item records', async () => {
        const before = await view();
        relationSnapshot = before.relations.map(r => ({ pets: r.pets, affinity: r.affinity, trust: r.trust, familiarity: r.familiarity }));
        await quit();
        await launch();
        await until(async () => (await inspect('stats')).pets.length === 5, 'Society restart did not restore owned pets');
        await inspect('society-sync');
        const after = await view();
        assert.ok(after.ledger.some(l => l.request === feedKey));
        assert.ok(!after.events.some(e => e.id === friendlyId));
        for (const r of relationSnapshot) {
            const current = after.relations.find(v => v.pets.join('|') === r.pets.join('|'));
            assert.ok(current);
            assert.equal(current.familiarity, r.familiarity);
            assert.ok(Math.abs(current.affinity - r.affinity) < 1);
        }
        await configure({ enabled: true, conflicts: true, bubbles: true, muted: false, frequency: 'normal', quiet_until: 0 });
        result.controlledSocialSetup = { seededState: true, triggerInterfaceExposedToRenderer: false, normalDefaultsRestored: true };
        return { relationships: relationSnapshot, feedKey, eventsRestored: true, deletedRemainsAbsent: true, normalExitAndNewHost: true };
    });
    await fs.copyFile(__filename, path.join(run, 'social-acceptance-driver.cjs'));
};
