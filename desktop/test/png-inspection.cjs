'use strict';

// Read-only PNG inspection for the two local preview assets. No image editing,
// resizing, cropping or encoding; decoded pixels never leave this process.
const fs = require('node:fs');
const { createHash } = require('node:crypto');
const { inflateSync } = require('node:zlib');

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function paeth(a, b, c) {
  const p = a + b - c;
  const da = Math.abs(p - a), db = Math.abs(p - b), dc = Math.abs(p - c);
  return da <= db && da <= dc ? a : db <= dc ? b : c;
}

function inspectPng(file) {
  const bytes = fs.readFileSync(file);
  if (bytes.length > 8 * 1024 * 1024 || !bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) throw new Error('Not a bounded PNG asset');
  let width, height, depth, colorType, interlace;
  let seenHeader = false, ended = false, at = 8;
  const compressed = [];
  while (at < bytes.length) {
    if (at + 12 > bytes.length) throw new Error('Truncated PNG chunk');
    const size = bytes.readUInt32BE(at);
    if (size > bytes.length - at - 12) throw new Error('PNG chunk exceeds input');
    const type = bytes.toString('ascii', at + 4, at + 8);
    const payload = bytes.subarray(at + 8, at + 8 + size);
    if (crc32(bytes.subarray(at + 4, at + 8 + size)) !== bytes.readUInt32BE(at + 8 + size)) throw new Error('PNG CRC mismatch');
    if (!seenHeader && type !== 'IHDR') throw new Error('PNG header is not first');
    if (type === 'IHDR') {
      if (seenHeader || size !== 13) throw new Error('Invalid PNG header');
      seenHeader = true;
      width = payload.readUInt32BE(0); height = payload.readUInt32BE(4);
      depth = payload[8]; colorType = payload[9]; interlace = payload[12];
      if (width < 1 || height < 1 || width > 4096 || height > 4096 || depth !== 8 || colorType !== 6 || interlace !== 0 || payload[10] !== 0 || payload[11] !== 0) throw new Error('Expected bounded noninterlaced 8-bit RGBA PNG');
    } else if (type === 'IDAT') compressed.push(payload);
    else if (type === 'IEND') {
      if (size !== 0) throw new Error('Invalid PNG end');
      ended = true; at += size + 12; break;
    }
    at += size + 12;
  }
  if (!ended || at !== bytes.length || !compressed.length) throw new Error('Incomplete PNG');
  const stride = width * 4;
  const scan = inflateSync(Buffer.concat(compressed), { maxOutputLength: (stride + 1) * height });
  if (scan.length !== (stride + 1) * height) throw new Error('Wrong PNG pixel size');
  const pixels = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = scan[y * (stride + 1)];
    if (filter > 4) throw new Error('Unknown PNG filter');
    for (let x = 0; x < stride; x++) {
      const index = y * stride + x;
      const left = x >= 4 ? pixels[index - 4] : 0;
      const above = y ? pixels[index - stride] : 0;
      const corner = x >= 4 && y ? pixels[index - stride - 4] : 0;
      const delta = filter === 1 ? left : filter === 2 ? above : filter === 3 ? Math.floor((left + above) / 2) : filter === 4 ? paeth(left, above, corner) : 0;
      pixels[index] = (scan[y * (stride + 1) + 1 + x] + delta) & 255;
    }
  }
  let transparent = 0, opaque = 0, partial = 0, borderOpaque = 0, borderMaxAlpha = 0;
  let minX = width, minY = height, maxX = -1, maxY = -1;
  const visible = { left: width, top: height, right: -1, bottom: -1 };
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const alpha = pixels[(y * width + x) * 4 + 3];
    if (!alpha) transparent++;
    else {
      if (alpha === 255) opaque++; else partial++;
      minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      if (x === 0 || x === width - 1 || y === 0 || y === height - 1) { borderOpaque++; borderMaxAlpha = Math.max(borderMaxAlpha, alpha); }
      // Keep raw alpha statistics above. An explicit 8/255 coverage threshold
      // distinguishes the visible character from generated 1/255 edge noise.
      if (alpha >= 8) {
        visible.left = Math.min(visible.left, x); visible.right = Math.max(visible.right, x);
        visible.top = Math.min(visible.top, y); visible.bottom = Math.max(visible.bottom, y);
      }
    }
  }
  const bbox = maxX < 0 ? null : { left: minX, top: minY, right: maxX, bottom: maxY, width: maxX - minX + 1, height: maxY - minY + 1 };
  const result = { width, height, depth, colorType, interlace, bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    transparent, opaque, partial, transparentFraction: transparent / (width * height), borderOpaque, borderMaxAlpha, bbox,
    visibleBboxAlphaThreshold: 8, visibleBbox: visible.right < 0 ? null : visible };
  return { result, pixels };
}

function compareFrames(first, second, clip = { left: .28, top: .35, right: .64, bottom: .51 }) {
  const a = first.result, b = second.result;
  if (a.width !== b.width || a.height !== b.height) throw new Error('Frame dimensions differ');
  let changed = 0, eyeChanged = 0, outsideChanged = 0, alphaChanged = 0;
  for (let y = 0; y < a.height; y++) for (let x = 0; x < a.width; x++) {
    const index = (y * a.width + x) * 4;
    if (!first.pixels[index + 3] && !second.pixels[index + 3]) continue;
    const visibleChange = Array.from({ length: 4 }, (_, channel) => Math.abs(first.pixels[index + channel] - second.pixels[index + channel])).some((delta) => delta > 8);
    if (Math.abs(first.pixels[index + 3] - second.pixels[index + 3]) > 8) alphaChanged++;
    if (visibleChange) {
      changed++;
      if (x >= a.width * clip.left && x < a.width * clip.right && y >= a.height * clip.top && y < a.height * clip.bottom) eyeChanged++;
      else outsideChanged++;
    }
  }
  return { thresholdPerChannel: 8, changed, eyeChanged, outsideChanged, alphaChanged,
    eyeClip: clip, note: 'Generated counterpart is not asserted to be pixel-identical outside the eyes; runtime clips its overlay to the eyes.' };
}

module.exports = { inspectPng, compareFrames };
