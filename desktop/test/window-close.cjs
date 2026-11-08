'use strict';

// Test driver only: close() may return before Chromium finishes beforeunload.
// A veto/timeout must fail the test, never force-destroy a view to claim success.
async function closeWindowAndWait(window, timeoutMs = 10000) {
  if (!window || window.isDestroyed()) return;
  await new Promise((resolve, reject) => {
    const done = error => {
      clearTimeout(timer); window.removeListener('closed', closed);
      if (error) reject(error); else resolve();
    };
    const closed = () => done();
    const timer = setTimeout(() => done(new Error('Owned window close did not complete')), timeoutMs);
    window.once('closed', closed);
    try { window.close(); } catch (error) { done(error); }
  });
}
module.exports = { closeWindowAndWait };
