'use strict';

// Original 32px geometric sprout-pet icon. No imported image, font or image library.
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const size = 32;
const pixels = Buffer.alloc(size * size * 4);
function ellipse(cx, cy, rx, ry, rgba) {
  for (let y = 0; y < size; y += 1) for (let x = 0; x < size; x += 1) {
    if (((x + 0.5 - cx) / rx) ** 2 + ((y + 0.5 - cy) / ry) ** 2 <= 1) {
      const offset = (y * size + x) * 4;
      for (let channel = 0; channel < 4; channel += 1) pixels[offset + channel] = rgba[channel];
    }
  }
}
ellipse(16, 18, 14, 12, [73, 102, 80, 255]);
ellipse(16, 18, 12, 10, [245, 243, 219, 255]);
ellipse(20, 5, 6, 3.5, [114, 151, 110, 255]);
ellipse(16, 8, 1.2, 4, [73, 102, 80, 255]);
ellipse(11, 17, 1.5, 2, [73, 102, 80, 255]);
ellipse(21, 17, 1.5, 2, [73, 102, 80, 255]);
ellipse(16, 22, 3.5, 1.4, [73, 102, 80, 255]);
ellipse(8, 21, 2, 1, [224, 189, 166, 255]);
ellipse(24, 21, 2, 1, [224, 189, 166, 255]);
function crc32(buffer) {
  let value = 0xffffffff;
  for (const byte of buffer) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return (value ^ 0xffffffff) >>> 0;
}
function chunk(type, bytes) {
  const name = Buffer.from(type);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([name, bytes])));
  return Buffer.concat([length, name, bytes, crc]);
}
const header = Buffer.alloc(13);
header.writeUInt32BE(size, 0);
header.writeUInt32BE(size, 4);
header[8] = 8;
header[9] = 6;
const rows = Buffer.alloc(size * (size * 4 + 1));
for (let y = 0; y < size; y += 1) pixels.copy(rows, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(rows)), chunk('IEND', Buffer.alloc(0)),
]);
const destination = path.resolve(__dirname, '../assets/tray.png');
if (fs.existsSync(destination) && !fs.readFileSync(destination).equals(png)) {
  throw new Error('Refusing to overwrite an existing different tray asset');
}
fs.mkdirSync(path.dirname(destination), { recursive: true });
fs.writeFileSync(destination, png, { flag: fs.existsSync(destination) ? 'w' : 'wx' });
process.stdout.write('Original tray.png generated (32x32 RGBA, ' + png.length + ' bytes)\n');
