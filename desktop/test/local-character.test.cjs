'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { ASSET_ID, FILES, parseLocalCharacter, validateLocalCharacter,
  selectedAsset, readLocalCharacterAssets } = require('../src/local-character.cjs');

const OWNER = '10000000-0000-4000-8000-000000000001';
const PET = '30000000-0000-4000-8000-000000000001';
const OTHER = '40000000-0000-4000-8000-000000000001';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');
const configuration = () => ({ kind: 'deepseek', ownerId: OWNER, petId: PET, assetId: ASSET_ID });
const argumentsFor = () => ['--local-character-preview=deepseek', '--preview-owner-id=' + OWNER, '--preview-pet-id=' + PET];

function fixture(t, populate = true) {
  const parent = fs.realpathSync(os.tmpdir());
  const root = fs.mkdtempSync(path.join(parent, 'weibiye-character-'));
  t.after(() => {
    assert.equal(path.dirname(root), parent);
    assert.ok(path.basename(root).startsWith('weibiye-character-'));
    fs.rmSync(root, { recursive: true, force: false });
  });
  if (populate) {
    fs.mkdirSync(path.join(root, 'local-preview'));
    for (const name of FILES) fs.writeFileSync(path.join(root, 'local-preview', name), PNG);
  }
  return root;
}

test('local character stays off by default without reading missing private assets', () => {
  assert.equal(parseLocalCharacter(['electron', 'app', '--ui-port=35316', '--inspect=0']), null);
  assert.equal(validateLocalCharacter(null), null);
  assert.deepEqual(readLocalCharacterAssets(null, 'not-an-existing-directory'), []);
});

test('three explicit CLI fields select one immutable canonical owner and pet', () => {
  const config = parseLocalCharacter(argumentsFor());
  assert.deepEqual(config, configuration());
  assert.equal(Object.isFrozen(config), true);
  const split = parseLocalCharacter(['--preview-pet-id', PET.toUpperCase(), '--local-character-preview', 'deepseek', '--preview-owner-id', OWNER.toUpperCase()]);
  assert.deepEqual(split, config);
});

test('unknown, incomplete, duplicate and malformed preview arguments fail closed', () => {
  for (const args of [
    ['--local-character-preview=deepseek'], ['--preview-owner-id=' + OWNER],
    ['--preview-pet-id=' + PET], ['--local-character-preview=deepseek', '--preview-owner-id=' + OWNER],
    ['--local-character-preview=other', '--preview-owner-id=' + OWNER, '--preview-pet-id=' + PET],
    [...argumentsFor(), '--local-character-preview=deepseek'], [...argumentsFor(), '--preview-pet-id=' + OTHER],
    ['--local-character-preview', '--preview-owner-id=' + OWNER, '--preview-pet-id=' + PET],
    [...argumentsFor(), '--preview-owner-file=C:/private'], ['--local-character-preview-path=C:/private'],
    ['--local-character-preview=deepseek', '--preview-owner-id=../owner', '--preview-pet-id=' + PET],
    ['--local-character-preview=deepseek', '--preview-owner-id=' + OWNER, '--preview-pet-id='],
  ]) assert.throws(() => parseLocalCharacter(args));
  assert.throws(() => parseLocalCharacter([null]));
});

test('configuration cannot supply alternate image paths, asset ids or extra fields', () => {
  for (const config of [
    { ...configuration(), directory: 'C:/private' }, { ...configuration(), assetId: 'cat' },
    { ...configuration(), petId: '*' }, { ...configuration(), ownerId: null },
    { kind: 'deepseek', ownerId: OWNER, petId: PET }, [], 'deepseek',
  ]) assert.throws(() => validateLocalCharacter(config));
});

test('appearance requires matching authenticated owner and exact pet id together', () => {
  const config = configuration();
  assert.equal(selectedAsset(config, { owner_id: OWNER, pet_id: PET }, OWNER), ASSET_ID);
  assert.equal(selectedAsset(config, { owner_id: OWNER, pet_id: OTHER }, OWNER), null);
  assert.equal(selectedAsset(config, { owner_id: OTHER, pet_id: PET }, OTHER), null);
  assert.equal(selectedAsset(config, { owner_id: OWNER, pet_id: PET }, OTHER), null);
  assert.equal(selectedAsset(config, { owner_id: OWNER, pet_id: PET }, null), null);
  assert.equal(selectedAsset(null, { owner_id: OWNER, pet_id: PET }, OWNER), null);
});

test('local reader exposes exactly two fixed PNG buffers from the project directory', (t) => {
  const root = fixture(t);
  const assets = readLocalCharacterAssets(configuration(), root);
  assert.deepEqual(assets.map((asset) => asset.name), FILES);
  assert.ok(assets.every((asset) => asset.type === 'image/png' && asset.bytes.equals(PNG)));
  assert.ok(assets.every(Object.isFrozen));
});

test('missing directory or either missing frame never falls back to a reference screenshot', (t) => {
  const root = fixture(t, false);
  assert.throws(() => readLocalCharacterAssets(configuration(), root));
  fs.mkdirSync(path.join(root, 'local-preview'));
  fs.writeFileSync(path.join(root, 'local-preview', FILES[0]), PNG);
  assert.throws(() => readLocalCharacterAssets(configuration(), root));
});

test('extra files or nested resources cannot silently join the local preview allowlist', (t) => {
  const root = fixture(t);
  fs.writeFileSync(path.join(root, 'local-preview', 'unreviewed.png'), PNG);
  assert.throws(() => readLocalCharacterAssets(configuration(), root));
});

test('linked preview directories are refused even when their target contains valid images', (t) => {
  const root = fixture(t, false);
  const target = path.join(root, 'separate-owned-fixture');
  fs.mkdirSync(target);
  for (const name of FILES) fs.writeFileSync(path.join(target, name), PNG);
  fs.symlinkSync(target, path.join(root, 'local-preview'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => readLocalCharacterAssets(configuration(), root));
});

test('non-PNG, oversized and excessive-dimension frames are rejected', (t) => {
  const root = fixture(t);
  const file = path.join(root, 'local-preview', FILES[0]);
  fs.writeFileSync(file, Buffer.alloc(100));
  assert.throws(() => readLocalCharacterAssets(configuration(), root));
  fs.writeFileSync(file, PNG);
  fs.truncateSync(file, 8 * 1024 * 1024 + 1);
  assert.throws(() => readLocalCharacterAssets(configuration(), root));
  const huge = Buffer.from(PNG); huge.writeUInt32BE(4097, 16);
  fs.writeFileSync(file, huge);
  assert.throws(() => readLocalCharacterAssets(configuration(), root));
});
