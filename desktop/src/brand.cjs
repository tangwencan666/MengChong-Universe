'use strict';
const { productName } = require('../package.json');
// Only this legacy, untracked support screen needs a compatibility caption.
// Never rewrite arbitrary page titles or user-generated conversation names.
function brandWindow(window) {
  const caption = title => title === '未毕业 · 连接帮助与反馈' ? `${productName} · 连接帮助与反馈` : title;
  const initial = window.getTitle();
  if (caption(initial) !== initial) window.setTitle(caption(initial));
  const update = (event, title) => {
    if (caption(title) !== title) { event.preventDefault(); window.setTitle(caption(title)); }
  };
  window.on('page-title-updated', update);
  window.once('closed', () => window.removeListener('page-title-updated', update));
}
module.exports = { productName, brandWindow };
