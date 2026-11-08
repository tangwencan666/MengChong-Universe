'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');
const {setTimeout:delay}=require('node:timers/promises');
const {createPowerRecovery}=require('../src/power-recovery.cjs');

test('resume bursts coalesce and shutdown removes listeners and pending work',async()=>{
  const monitor=new EventEmitter();let calls=0,finish;
  const recovery=createPowerRecovery({powerMonitor:monitor,delayMs:1,recover:()=>{calls++;return new Promise(resolve=>{finish=resolve;});}});
  for(let i=0;i<30;i++)monitor.emit('resume');
  await delay(15);assert.equal(calls,1);
  monitor.emit('unlock-screen');await delay(5);assert.equal(calls,1);
  finish();await delay(5);recovery.stop();monitor.emit('resume');await delay(5);
  assert.equal(calls,1);assert.equal(monitor.listenerCount('resume'),0);
});

test('recovery failure reports a fixed signal and never retries endlessly',async()=>{
  const monitor=new EventEmitter();let failures=0,calls=0;
  const recovery=createPowerRecovery({powerMonitor:monitor,delayMs:1,recover:async()=>{calls++;throw Error('synthetic private content');},failed:()=>{failures++;}});
  monitor.emit('resume');await delay(20);recovery.stop();assert.equal(calls,1);assert.equal(failures,1);
});
