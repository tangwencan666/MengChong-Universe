'use strict';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SAFE_UI = /^\/(?:$|companions$|pet-catalog$|pets\/[0-9a-f-]+(?:\/(?:chat\/[0-9a-f-]+|memory))?$|chat\/[0-9a-f-]+$|(?:login|register|forgot-password|resend-verification|verify-email|reset-password|me|me\/sessions|memory|wallet|beta|welcome|preferences\/conversations|admin|companion)$)/i;

function fail(code, message = '暂时无法完成操作，请确认登录状态后重试。') {
  return Object.assign(new Error(message), { code, desktopSafe: true });
}

function petId(value) {
  if (typeof value !== 'string' || !UUID.test(value)) throw fail('INVALID_PET', '宠物身份无效。');
  return value.toLowerCase();
}

function origin(value) {
  const parsed = new URL(value);
  if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1'
    || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw fail('INVALID_ORIGIN', '桌面预览只允许本机独立服务。');
  }
  return parsed.origin;
}

function localURL(value, base) {
  try {
    const parsed = new URL(value);
    if (parsed.origin !== base || parsed.username || parsed.password) return null;
    return parsed;
  } catch { return null; }
}

function uiNavigation(value, base, boundPet) {
  const parsed = localURL(value, base);
  if (!parsed) return false;
  if (!boundPet) return SAFE_UI.test(parsed.pathname);
  const id = petId(boundPet);
  return new RegExp(`^/pets/${id}(?:/(?:chat/[0-9a-f-]+|memory))?$`, 'i').test(parsed.pathname);
}

function petResource(value, base) {
  const parsed = localURL(value, base);
  return Boolean(parsed && /^\/(?:__pet\/(?:pet\.html|pet\.css|pet\.js|pet-actions\.css|pet-action-view\.js|pet-mood\.js|pet-appearance\.js|pet-catalog\.js)|__assets\/[a-zA-Z0-9_.-]+)$/.test(parsed.pathname));
}

function pointer(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== 2 || !Number.isFinite(value.x) || !Number.isFinite(value.y)
    || Math.abs(value.x) > 100000 || Math.abs(value.y) > 100000) {
    throw fail('INVALID_POINTER', '鼠标位置无效。');
  }
  return { x: Math.round(value.x), y: Math.round(value.y) };
}

function identity(ownerId, pet) {
  const owner = petId(ownerId);
  const id = petId(pet?.pet_id);
  if (!pet || !['active', 'hidden'].includes(pet.status)
    || typeof pet.name !== 'string' || !pet.name.trim() || pet.name.length > 60
    || /[\x00-\x1f\x7f]/.test(pet.name) || !['cat', 'dog', 'custom'].includes(pet.role_type)
    || !/^#[0-9a-f]{6}$/i.test(pet.appearance_config?.tint ?? '')) {
    throw fail('PET_UNAVAILABLE', '这只宠物目前不可放到桌面。');
  }
  return Object.freeze({ owner_id: owner, pet_id: id, name: pet.name,
    role_type: pet.role_type, tint: pet.appearance_config.tint });
}

module.exports = { UUID, fail, petId, origin, localURL, uiNavigation, petResource, pointer, identity };
