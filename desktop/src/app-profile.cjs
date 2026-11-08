'use strict';
const path = require('node:path');
const APP_ID = 'com.weibiye.desktop';
function profileDirectory({ explicit, packaged, appData, rootDir }) {
  const selected = explicit ?? (packaged ? path.join(appData, 'WeiBiYe') : path.join(rootDir, '.runtime/profile'));
  if (typeof selected !== 'string' || !path.isAbsolute(selected)) throw new TypeError('Absolute profile directory required');
  return path.normalize(selected);
}
module.exports = { APP_ID, profileDirectory };
