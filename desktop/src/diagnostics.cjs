'use strict';
const fs = require('node:fs');
const path = require('node:path');
const EVENTS = new Set(['started', 'stopped', 'startup_failed', 'cleanup_failed', 'ui_parked', 'ui_restored', 'renderer_gone', 'child_gone', 'resume_failed']);
const ROLES = new Set(['host', 'main', 'chat', 'pet']);
const REASONS = new Set(['clean-exit', 'abnormal-exit', 'killed', 'crashed', 'oom', 'launch-failed', 'integrity-failure', 'unknown']);
const LIMIT = 256 * 1024;

function safeEvent(event, metadata = {}) {
  if (!EVENTS.has(event) || !metadata || typeof metadata !== 'object' || Array.isArray(metadata)
    || Object.keys(metadata).some(key => !['role', 'reason', 'windowCount', 'petCount'].includes(key))) return null;
  if (metadata.role !== undefined && !ROLES.has(metadata.role)) return null;
  if (metadata.reason !== undefined && !REASONS.has(metadata.reason)) return null;
  if (['windowCount', 'petCount'].some(key => metadata[key] !== undefined
    && (!Number.isInteger(metadata[key]) || metadata[key] < 0 || metadata[key] > 20))) return null;
  return { event, ...metadata };
}

function createDiagnostics({ directory, version, enabled = false }) {
  if (!path.isAbsolute(directory) || !/^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/.test(version)) throw new TypeError('Invalid diagnostics options');
  const folder = path.join(directory, 'diagnostics-v1');
  const file = path.join(folder, 'events.jsonl'), previous = path.join(folder, 'events.1.jsonl');
  const regular = candidate => {
    try { const s = fs.lstatSync(candidate); return s.isFile() && !s.isSymbolicLink() && s.size <= LIMIT; }
    catch (error) { return error.code === 'ENOENT'; }
  };
  return {
    enabled,
    write(event, metadata) {
      if (!enabled) return false;
      const safe = safeEvent(event, metadata);
      if (!safe) return false;
      try {
        fs.mkdirSync(folder, { recursive: true });
        if (fs.lstatSync(folder).isSymbolicLink() || fs.realpathSync(folder) !== path.resolve(folder)
          || !regular(file) || !regular(previous)) return false;
        const line = JSON.stringify({ schema: 'weibiye-diagnostics/1', at: new Date().toISOString(), version, ...safe }) + '\n';
        let size = 0;
        try { size = fs.statSync(file).size; } catch (error) { if (error.code !== 'ENOENT') return false; }
        if (size + Buffer.byteLength(line) > LIMIT) fs.renameSync(file, previous);
        fs.appendFileSync(file, line, { encoding: 'utf8', mode: 0o600 }); return true;
      } catch { return false; }
    },
  };
}
module.exports = { createDiagnostics, safeEvent, LIMIT };
