'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { inspectPng, compareFrames } = require('./png-inspection.cjs');
const { resolveSourceImage } = require('./source-image-resolver.cjs');

const root = path.resolve(__dirname, '../..');
const directory = path.join(root, 'desktop/local-preview');
const localArtworkAbsent = !fs.existsSync(path.join(directory, 'deepseek-open.png')) && !fs.existsSync(path.join(directory, 'deepseek-blink.png'));
const sourceManifest = path.join(root, '.verification/p7/before.json');

test('P7 image files use real transparent alpha and visible-content padding, not a screenshot background', { skip: localArtworkAbsent && 'Local preview artwork deliberately absent; not bundled or licensed for distribution' }, () => {
  for (const name of ['deepseek-open.png','deepseek-blink.png']) {
    const { result } = inspectPng(path.join(directory, name));
    assert.equal(result.colorType, 6);
    assert.ok(result.width >= 512 && result.height >= 512);
    assert.ok(result.transparentFraction > .15 && result.transparentFraction < .8);
    // A whole white/black screenshot background would have alpha near 255.
    // Generated low-coverage noise is retained and reported, never edited away.
    assert.ok(result.borderMaxAlpha <= 1, 'Visible character or matte touches the image border');
    assert.ok(result.opaque > 0 && result.partial > 0);
    assert.ok(result.visibleBbox.left >= 8 && result.visibleBbox.top >= 8);
    assert.ok(result.visibleBbox.right < result.width - 8 && result.visibleBbox.bottom < result.height - 8);
    assert.ok(result.bytes <= 8 * 1024 * 1024);
  }
});

test('P7 blink matches the open frame dimensions and bounded visible alignment; the explicit eye region changes', { skip: localArtworkAbsent && 'Local preview artwork deliberately absent; not bundled or licensed for distribution' }, () => {
  const first = inspectPng(path.join(directory, 'deepseek-open.png'));
  const second = inspectPng(path.join(directory, 'deepseek-blink.png'));
  const comparison = compareFrames(first, second);
  assert.equal(first.result.width, second.result.width);
  assert.equal(first.result.height, second.result.height);
  assert.notEqual(first.result.sha256, second.result.sha256);
  for (const edge of ['left','top','right','bottom']) assert.ok(Math.abs(first.result.visibleBbox[edge] - second.result.visibleBbox[edge]) <= 4, 'Visible frame silhouette moved too far at ' + edge);
  assert.ok(comparison.eyeChanged > 1000, 'A duplicate open frame must not count as a blink');
});

test('P7 supplied source images retain their original hashes', { skip: !fs.existsSync(sourceManifest) && 'Local source-image manifest not distributed' }, () => {
  const original = JSON.parse(fs.readFileSync(sourceManifest, 'utf8'));
  assert.equal(Object.keys(original.images).length, 2);
  for (const [file, expected] of Object.entries(original.images)) {
    const actual = resolveSourceImage(file, expected);
    assert.equal(createHash('sha256').update(fs.readFileSync(actual)).digest('hex'), expected.sha256);
    assert.equal(fs.statSync(actual).size, expected.bytes);
  }
});
