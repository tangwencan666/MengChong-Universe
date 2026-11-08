'use strict';

// This local, opt-in appearance override is not a backend identity or a licensed
// distribution asset. It can affect only one already-authorized owner/pet pair.
const fs = require('node:fs');
const path = require('node:path');
const { UUID } = require('./policy.cjs');

const ASSET_ID = 'deepseek-local-preview';
const FILES = Object.freeze(['deepseek-blink.png', 'deepseek-open.png']);
const FLAGS = Object.freeze(['local-character-preview', 'preview-owner-id', 'preview-pet-id']);
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const MAX_ASSET_BYTES = 8 * 1024 * 1024;

function invalid() { return new Error('Local character preview requires the supported character and one explicit owner/pet pair.'); }

function validateLocalCharacter(value) {
  if (value === null || value === undefined) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join('|') !== 'assetId|kind|ownerId|petId'
    || value.kind !== 'deepseek' || value.assetId !== ASSET_ID
    || typeof value.ownerId !== 'string' || !UUID.test(value.ownerId)
    || typeof value.petId !== 'string' || !UUID.test(value.petId)) throw invalid();
  return Object.freeze({ kind: 'deepseek', ownerId: value.ownerId.toLowerCase(),
    petId: value.petId.toLowerCase(), assetId: ASSET_ID });
}

function parseLocalCharacter(argv) {
  if (!Array.isArray(argv) || argv.some((value) => typeof value !== 'string')) throw invalid();
  const values = new Map();
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (!argument.startsWith('--local-character') && !argument.startsWith('--preview-')) continue;
    const separator = argument.indexOf('=');
    const name = argument.slice(2, separator < 0 ? undefined : separator);
    if (!FLAGS.includes(name) || values.has(name)) throw invalid();
    let value;
    if (separator >= 0) value = argument.slice(separator + 1);
    else { value = argv[++index]; if (!value || value.startsWith('--')) throw invalid(); }
    if (!value) throw invalid();
    values.set(name, value);
  }
  if (values.size === 0) return null;
  if (values.size !== FLAGS.length) throw invalid();
  return validateLocalCharacter({ kind: values.get('local-character-preview'),
    ownerId: values.get('preview-owner-id'), petId: values.get('preview-pet-id'), assetId: ASSET_ID });
}

function selectedAsset(configuration, identity, currentOwner) {
  const preview = validateLocalCharacter(configuration);
  return preview && identity && currentOwner === preview.ownerId
    && identity.owner_id === preview.ownerId && identity.pet_id === preview.petId ? preview.assetId : null;
}

function readLocalCharacterAssets(configuration, rootDir) {
  if (!validateLocalCharacter(configuration)) return [];
  if (typeof rootDir !== 'string' || !path.isAbsolute(rootDir)) throw invalid();
  const root = fs.realpathSync(rootDir);
  const directory = path.join(root, 'local-preview');
  const info = fs.lstatSync(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Local preview assets must be a real project directory.');
  const directoryReal = fs.realpathSync(directory);
  if (directoryReal !== directory) throw new Error('Local preview directory escaped its fixed location.');
  const names = fs.readdirSync(directory).sort();
  if (names.length !== FILES.length || names.some((name, index) => name !== FILES[index])) {
    throw new Error('Local preview must contain exactly its two reviewed PNG frames.');
  }
  return FILES.map((name) => {
    const file = path.join(directory, name);
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 45 || stat.size > MAX_ASSET_BYTES
      || fs.realpathSync(file) !== file) throw new Error('Local preview asset is missing, linked or outside its size budget.');
    const bytes = fs.readFileSync(file);
    if (bytes.length !== stat.size || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)
      || bytes.readUInt32BE(8) !== 13 || bytes.toString('ascii', 12, 16) !== 'IHDR') {
      throw new Error('Local preview frames must be PNG images.');
    }
    const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
    if (!width || !height || width > 4096 || height > 4096 || width * height > 8 * 1024 * 1024) {
      throw new Error('Local preview dimensions exceed their decoded-image budget.');
    }
    return Object.freeze({ name, bytes, type: 'image/png' });
  });
}

module.exports = { ASSET_ID, FILES, parseLocalCharacter, validateLocalCharacter,
  selectedAsset, readLocalCharacterAssets };
