'use strict';
// Original geometric SVG placeholders, authored for this project. No downloaded media.
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../assets');
function cat(kind, pose) {
    const funny = kind === 'maodie', cream = funny ? '#edc889' : '#fff3dc', edge = funny ? '#815b3c' : '#987b77';
    const eyes = pose === 'blink' || pose === 'sleep'
        ? `<path d="M46 65q8 6 16 0m24 0q8 6 16 0" stroke="${edge}" stroke-width="3" stroke-linecap="round"/>`
        : funny ? '<ellipse cx="53" cy="64" rx="10" ry="12" fill="#fff"/><ellipse cx="94" cy="68" rx="11" ry="9" fill="#fff"/><circle cx="55" cy="62" r="4" fill="#674f3d"/><circle cx="91" cy="69" r="4" fill="#674f3d"/>'
            : '<ellipse cx="54" cy="66" rx="5" ry="7" fill="#816767"/><ellipse cx="94" cy="66" rx="5" ry="7" fill="#816767"/><circle cx="52" cy="64" r="1.5" fill="#fff"/><circle cx="92" cy="64" r="1.5" fill="#fff"/>';
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 148 148" fill="none"><title>WeiBiYe original ${kind} ${pose} placeholder</title>
<path d="M108 113c25 1 27-20 15-24" stroke="${cream}" stroke-width="12" stroke-linecap="round"/>
<ellipse cx="74" cy="111" rx="34" ry="24" fill="${cream}" stroke="${edge}" stroke-width="2.5"/>
<ellipse cx="74" cy="114" rx="18" ry="14" fill="#fffaf0"/><path d="m37 52 2-33 24 20m24-1 24-19 0 34" fill="${cream}" stroke="${edge}" stroke-width="2.5" stroke-linejoin="round"/>
<path d="m44 30 1 17 12-7m46-9-11 10 12 6" fill="#efb9b3"/>
<path d="M31 68c0-23 16-35 43-35s43 12 43 35-16 34-43 34-43-11-43-34Z" fill="${cream}" stroke="${edge}" stroke-width="2.5"/>
${funny ? '<path d="m59 36 5 15m12-17 1 16m14-12-6 14" stroke="#bd8d55" stroke-width="5" stroke-linecap="round"/>' : ''}${eyes}
<ellipse cx="41" cy="78" rx="8" ry="4" fill="#efb9b3"/><ellipse cx="107" cy="78" rx="8" ry="4" fill="#efb9b3"/>
<path d="m70 77 4 3 4-3m-4 4c-4 7-8 4-10 2m10-2c4 7 8 4 10 2" stroke="${edge}" stroke-width="2" stroke-linecap="round"/>
${funny ? '<path d="m41 51 19-5m27 6 16 4m-43 32 6 8 3-7" stroke="#815b3c" stroke-width="2" stroke-linecap="round"/>' : '<path d="M69 114c-9-8-15 5 5 13 20-8 14-21 5-13l-5 5Z" fill="#e9bfc4"/>'}
${pose === 'sleep' ? '<text x="112" y="28" fill="#847292" font-size="15" font-family="sans-serif">zZ</text>' : ''}</svg>\n`;
}
for (const kind of ['maodie', 'hajimi'])
    for (const pose of ['idle', 'blink', 'sleep']) {
        const file = path.join(root, 'p84-' + kind + (pose === 'idle' ? '' : '-' + pose) + '.svg');
        fs.writeFileSync(file, cat(kind, pose));
    }
for (const [kind, base] of [['moon', 'cat'], ['doubao', 'dog'], ['xiaoyun', 'cloud']]) {
    const original = fs.readFileSync(path.join(root, base + '.svg'), 'utf8');
    for (const pose of ['blink', 'sleep']) {
        // Original base art plus an eye overlay; all strokes stay in this project's style.
        const y = base === 'cloud' ? 74 : 65;
        const overlay = `<g><ellipse cx="54" cy="${y}" rx="11" ry="7" fill="#F9F5E8"/><ellipse cx="94" cy="${y}" rx="11" ry="7" fill="#F9F5E8"/><path d="M46 ${y}q8 5 16 0m24 0q8 5 16 0" stroke="#536A59" stroke-width="2.5" stroke-linecap="round"/>${pose === 'sleep' ? '<text x="114" y="25" fill="#7e7590" font-size="15" font-family="sans-serif">zZ</text>' : ''}</g>`;
        fs.writeFileSync(path.join(root, `p84-${kind}-${pose}.svg`), original.replace('</svg>', overlay + '</svg>'));
    }
}
console.log('Generated 12 original P8.4 SVG placeholder resources.');
