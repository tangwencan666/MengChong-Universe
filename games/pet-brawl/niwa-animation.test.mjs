import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {NIWA_LAUGH_FRAMES,NIWA_LAUGH_CROP,laughFrameIndex,clearFrameBackground} from './niwa-animation.mjs';
test('eight distinct source-video frames exist with consistent dimensions',async()=>{
 const hashes=[];for(const file of NIWA_LAUGH_FRAMES){const png=await readFile(new URL(file,import.meta.url));assert.equal(png.readUInt32BE(16),720);assert.equal(png.readUInt32BE(20),1566);hashes.push(createHash('sha256').update(png).digest('hex'));}assert.equal(new Set(hashes).size,8);
});
test('character crop excludes the top phone UI and bottom controls',()=>{const c=NIWA_LAUGH_CROP;assert.ok(c.x>=0&&c.x+c.width<=720);assert.ok(c.y>=400&&c.y+c.height<=1280);});
test('animation frame selection is bounded and reduced motion keeps a real static pose',()=>{assert.equal(laughFrameIndex(.16),1);assert.equal(laughFrameIndex(500,true),0);for(const time of [0,.3,1,2,50])assert.ok(laughFrameIndex(time)>=0&&laughFrameIndex(time)<8);});
test('edge-connected white is transparent while enclosed white teeth and colored body are preserved',()=>{
 const pixels=new Uint8ClampedArray(7*7*4).fill(255);
 for(let y=2;y<=4;y++)for(let x=2;x<=4;x++){const i=(y*7+x)*4;pixels[i]=180;pixels[i+1]=120;pixels[i+2]=10;}
 const center=(3*7+3)*4;pixels[center]=pixels[center+1]=pixels[center+2]=255;
 clearFrameBackground(pixels,7,7);assert.equal(pixels[3],0);assert.equal(pixels[center+3],255);assert.equal(pixels[(2*7+2)*4+3],255);
});
