import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createWhaleVoice, createSkillVoice } from './sound.mjs';

function media() { return { paused: true, ended: false, currentTime: 0, plays: 0, pauses: 0, play() { this.paused = false; this.plays++; return Promise.resolve(); }, pause() { this.paused = true; this.pauses++; }, addEventListener() {} }; }
async function inspectCue(asset) {
  const data = await readFile(new URL(`./assets/${asset}-skill.wav`, import.meta.url));
  assert.equal(data.toString('ascii', 0, 4), 'RIFF'); assert.equal(data.toString('ascii', 8, 12), 'WAVE');
  let fmt, audio;
  for (let i = 12; i + 8 <= data.length;) { const name = data.toString('ascii', i, i + 4), length = data.readUInt32LE(i + 4); if (name === 'fmt ') fmt = data.subarray(i + 8, i + 8 + length); if (name === 'data') audio = data.subarray(i + 8, i + 8 + length); i += 8 + length + length % 2; }
  assert.equal(fmt.readUInt16LE(0), 1); assert.equal(fmt.readUInt16LE(2), 2); assert.equal(fmt.readUInt16LE(14), 16);
  const seconds = audio.length / fmt.readUInt32LE(8);
  let squared = 0; for (let i = 0; i < audio.length; i += 2) squared += (audio.readInt16LE(i) / 32768) ** 2;
  assert.ok(Math.sqrt(squared / (audio.length / 2)) > .005);
  return seconds;
}
test('original whale cue is a non-silent stereo PCM file approximately two seconds long', async () => {
  const seconds = await inspectCue('whale'); assert.ok(seconds >= 2 && seconds < 2.1);
});
test('original daodun video cue has exactly two seconds of non-silent stereo PCM samples', async () => {
  assert.equal(await inspectCue('daodun'), 2);
});
test('niwa laugh cue retains a non-silent 2.6-second original voice excerpt', async () => {
  assert.equal(await inspectCue('niwa'),2.6);
});
test('whale and shield cues keep separate playback state and never replace each other', () => {
  const whale = media(), shield = media(), a = createSkillVoice(whale), b = createSkillVoice(shield);
  a.play(); whale.currentTime = .8; b.play(); assert.equal(whale.currentTime, .8); assert.equal(shield.plays, 1);
  b.stop(); assert.equal(whale.paused, false); assert.equal(shield.paused, true);
});
test('a cast plays a single bounded cue with no loop or simultaneous voice instances', () => {
  const m = media(), voice = createWhaleVoice(m); voice.play(); assert.equal(m.plays, 1); assert.equal(m.loop, false); assert.equal(m.volume, .45);
  m.currentTime = .8; voice.play(); assert.equal(m.plays, 2); assert.equal(m.currentTime, 0); assert.ok(m.pauses >= 2);
});
test('pause and resume preserve the original cue position, including duplicate pause notifications', () => {
  const m = media(), voice = createWhaleVoice(m); voice.play(); m.currentTime = .7; voice.pause(); voice.pause(); assert.equal(m.paused, true);
  voice.resume(); assert.equal(m.currentTime, .7); assert.equal(m.paused, false); assert.equal(m.plays, 2); voice.resume(); assert.equal(m.plays, 2);
});
test('mute, restart and finish stop the cue and cannot later resume stale speech', () => {
  const m = media(), voice = createWhaleVoice(m); voice.play(); voice.pause(); voice.setEnabled(false); assert.equal(m.currentTime, 0);
  voice.setEnabled(true); voice.resume(); assert.equal(m.plays, 1); voice.play(); voice.stop(); voice.resume(); assert.equal(m.plays, 2); assert.equal(m.paused, true);
});
test('blocked audio playback does not break the combat loop', async () => {
  const m = media(); m.play = () => Promise.reject(new Error('autoplay denied'));
  const voice = createWhaleVoice(m); assert.doesNotThrow(() => voice.play()); await new Promise(resolve => setTimeout(resolve, 0));
  voice.setEnabled(false); assert.doesNotThrow(() => voice.play());
});
