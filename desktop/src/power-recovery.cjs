'use strict';
function createPowerRecovery({ powerMonitor, recover, failed = () => {}, delayMs = 500 }) {
  let timer, running = false, stopped = false;
  const resume = () => {
    if (stopped || timer || running) return;
    timer = setTimeout(async () => {
      timer = undefined; running = true;
      try { if(!stopped) await recover(); } catch { if(!stopped) failed(); }
      finally { running = false; }
    }, delayMs);
    timer.unref?.();
  };
  powerMonitor.on('resume', resume);
  powerMonitor.on('unlock-screen', resume);
  return { stop() { stopped = true; clearTimeout(timer); powerMonitor.removeListener('resume', resume); powerMonitor.removeListener('unlock-screen', resume); } };
}
module.exports={createPowerRecovery};
