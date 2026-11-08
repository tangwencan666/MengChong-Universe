'use strict';
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');

function validateServiceProfile(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !['schema', 'mode', 'origin'].includes(key))
    || value.schema !== 'weibiye-service/1' || !['local', 'hosted'].includes(value.mode)) throw new Error('Invalid service profile');
  if (value.mode === 'local') {
    if (value.origin !== null) throw new Error('Local service profile cannot contain a remote origin');
    return Object.freeze({ schema: value.schema, mode: 'local', origin: null });
  }
  let endpoint;
  try { endpoint = new URL(value.origin); } catch { throw new Error('Invalid HTTPS service origin'); }
  if (endpoint.protocol !== 'https:' || endpoint.origin !== value.origin || endpoint.username || endpoint.password
    || endpoint.pathname !== '/' || endpoint.search || endpoint.hash || net.isIP(endpoint.hostname)
    || !/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(endpoint.hostname)
    || /(?:^|\.)(?:localhost|local|invalid)$/.test(endpoint.hostname)) throw new Error('Hosted UI requires one approved HTTPS DNS origin');
  return Object.freeze({ schema: value.schema, mode: 'hosted', origin: endpoint.origin });
}

function loadServiceProfile(root) {
  const file = path.join(root, 'service-profile.json');
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) throw new Error('Invalid bundled service profile');
  return validateServiceProfile(JSON.parse(fs.readFileSync(file, 'utf8')));
}
module.exports = { validateServiceProfile, loadServiceProfile };
