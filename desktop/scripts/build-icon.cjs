'use strict';
// Re-render the existing original P6 sprout geometry at native ICO resolutions.
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const shapes = [
  [16,18,14,12,[73,102,80]], [16,18,12,10,[245,243,219]], [20,5,6,3.5,[114,151,110]],
  [16,8,1.2,4,[73,102,80]], [11,17,1.5,2,[73,102,80]], [21,17,1.5,2,[73,102,80]],
  [16,22,3.5,1.4,[73,102,80]], [8,21,2,1,[224,189,166]], [24,21,2,1,[224,189,166]],
];
function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) { value ^= byte; for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ value >>> 1 : value >>> 1; }
  return (value ^ 0xffffffff) >>> 0;
}
function chunk(type, bytes) {
  const name = Buffer.from(type), length = Buffer.alloc(4), crc = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length); crc.writeUInt32BE(crc32(Buffer.concat([name, bytes])));
  return Buffer.concat([length, name, bytes, crc]);
}
function png(size) {
  const rows = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const color = [0,0,0]; let covered = 0;
    for (const oy of [.25,.75]) for (const ox of [.25,.75]) {
      const px = (x + ox) * 32 / size, py = (y + oy) * 32 / size;
      let selected;
      for (const [cx,cy,rx,ry,fill] of shapes) if (((px-cx)/rx)**2 + ((py-cy)/ry)**2 <= 1) selected = fill;
      if (selected) { covered++; for (let k=0;k<3;k++) color[k] += selected[k]; }
    }
    const at = y * (size * 4 + 1) + 1 + x * 4;
    for (let k=0;k<3;k++) rows[at+k] = covered ? Math.round(color[k]/covered) : 0;
    rows[at+3] = Math.round(255 * covered/4);
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(size); header.writeUInt32BE(size,4); header[8]=8; header[9]=6;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',zlib.deflateSync(rows)),chunk('IEND',Buffer.alloc(0))]);
}
function makeIcon() {
  const sizes = [16,24,32,48,64,128,256], frames = sizes.map(png), directory = Buffer.alloc(6 + sizes.length*16);
  directory.writeUInt16LE(1,2); directory.writeUInt16LE(sizes.length,4); let offset = directory.length;
  for (let i=0;i<sizes.length;i++) {
    const at = 6 + i*16; directory[at] = directory[at+1] = sizes[i] === 256 ? 0 : sizes[i];
    directory.writeUInt16LE(1,at+4); directory.writeUInt16LE(32,at+6); directory.writeUInt32LE(frames[i].length,at+8); directory.writeUInt32LE(offset,at+12); offset += frames[i].length;
  }
  return Buffer.concat([directory,...frames]);
}
if (require.main === module) {
  const output = path.resolve(__dirname,'../assets/app.ico'), bytes = makeIcon();
  if (fs.existsSync(output)) { if (!fs.readFileSync(output).equals(bytes)) throw new Error('Existing icon differs; preserving it'); }
  else fs.writeFileSync(output,bytes,{flag:'wx'});
  console.log('Original application ICO generated: 16–256px');
}
module.exports = { makeIcon };
