'use strict';
// Presentation only: actual social state is the sole source of mood. No timer,
// random choice, face editing or mutation of the desktop action engine.
(function(root) {
  const known = new Set(['happy','calm','curious','angry','upset','sad','shy','sleepy']);
  function posture(identity, hidden = false) {
    const mood = identity?.social?.mood;
    if (hidden || identity?.visible === false || identity?.state === 'dragging'
      || ['thinking','speaking'].includes(identity?.activity)
      || !['idle','breathe','blink','look'].includes(identity?.action)
      || !known.has(mood)) return 'none';
    return mood;
  }
  const api = Object.freeze({posture});
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.WeiBiYePetMood = api;
})(typeof globalThis === 'object' ? globalThis : this);
