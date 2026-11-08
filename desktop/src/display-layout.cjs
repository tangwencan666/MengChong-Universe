'use strict';

// Electron screen and BrowserWindow geometry are both DIP. Never multiply by DPI.
function areas(displays, width = 188, height = 196) {
  if (!Array.isArray(displays) || displays.length > 32) throw new TypeError('Invalid displays');
  const result = displays.flatMap((display) => {
    const box = display?.workArea;
    if (!box || ![box.x, box.y, box.width, box.height].every(Number.isFinite)
      || Math.abs(box.x) > 100000 || Math.abs(box.y) > 100000
      || box.width < width || box.height < height || box.width > 100000 || box.height > 100000) return [];
    return [{ id: String(display.id ?? 'primary').slice(0, 80),
      x: Math.round(box.x), y: Math.round(box.y), width: Math.floor(box.width), height: Math.floor(box.height) }];
  });
  if (!result.length) throw new RangeError('No display fits a pet window');
  return result;
}

function clamp(area, point, width, height) {
  return { x: Math.round(Math.max(area.x, Math.min(area.x + area.width - width, point.x))),
    y: Math.round(Math.max(area.y, Math.min(area.y + area.height - height, point.y))) };
}

function nearest(displays, point, width, height) {
  return [...displays].sort((a, b) => {
    const distance = (area) => { const p = clamp(area, point, width, height); return Math.hypot(p.x - point.x, p.y - point.y); };
    return distance(a) - distance(b);
  })[0];
}

function restore(saved, displays, width, height) {
  if (!saved) return null;
  const original = saved.workArea;
  const matching = displays.find((area) => area.id === saved.displayId);
  let point = saved;
  if (matching && original && original.width >= width && original.height >= height) {
    const fraction = (value, base, size, petSize) => Math.max(0, Math.min(1, (value - base) / Math.max(1, size - petSize)));
    point = { x: matching.x + fraction(saved.x, original.x, original.width, width) * (matching.width - width),
      y: matching.y + fraction(saved.y, original.y, original.height, height) * (matching.height - height) };
  }
  return clamp(matching ?? nearest(displays, point, width, height), point, width, height);
}

function capture(point, displays, width, height) {
  const area = nearest(displays, point, width, height);
  const { id, ...workArea } = area;
  return { ...clamp(area, point, width, height), displayId: id, workArea };
}

module.exports = { areas, clamp, nearest, restore, capture };
