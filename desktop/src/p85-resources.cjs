'use strict';
// Central metrics sampling prevents competing CPU sample clocks. Eight snapshots
// allow local acceptance to collect every interval without unbounded retention.
const HIGH_KIB = 1024 * 1024, LOW_KIB = 850 * 1024, MAX_WINDOWS = 12;
function createResourceMonitor(read, now = Date.now) {
    let last = -Infinity, sequence = 0, reduced = false, available = false, history = [];
    function sample(force = false) {
        const time = now();
        if (!force && time - last < 5000)
            return;
        let metrics;
        try {
            metrics = read?.();
        }
        catch { }
        const elapsedMs = Number.isFinite(last) ? Math.max(1, time - last) : 0;
        last = time;
        available = Array.isArray(metrics) && metrics.length > 0 && metrics.every(p => Number.isFinite(p.memory?.privateBytes) && p.memory.privateBytes >= 0);
        if (!available)
            return;
        const privateKiB = metrics.reduce((sum, p) => sum + p.memory.privateBytes, 0);
        reduced = reduced ? privateKiB >= LOW_KIB : privateKiB >= HIGH_KIB;
        history.push({ sequence: ++sequence, at: time, elapsedMs, privateKiB, metrics });
        history = history.slice(-8);
    }
    return { sample,
        get state() { return { reduced_motion: reduced, metrics_available: available, private_kib: history.at(-1)?.privateKiB ?? null }; },
        get samples() { return structuredClone(history); },
        mayAllocate(windowCount) { sample(true); return windowCount < MAX_WINDOWS && !reduced; },
        close() { history = []; },
    };
}
module.exports = { createResourceMonitor, HIGH_KIB, LOW_KIB, MAX_WINDOWS };
