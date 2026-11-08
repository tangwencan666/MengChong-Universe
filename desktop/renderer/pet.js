'use strict';

(() => {
  const bridge = window.weibiyePet;
  const button = document.getElementById('pet-hitbox');
  const art = document.getElementById('pet-art');
  const blink = document.getElementById('pet-blink');
  const name = document.getElementById('pet-name');
  const bubble = document.getElementById('pet-bubble');
  const controller = new AbortController();
  const signal = controller.signal;
  // Only these shipped, original assets can be selected. No user-defined URL/path.
  const assets = Object.freeze({ cat: '/__assets/cat.svg', dog: '/__assets/dog.svg', cloud: '/__assets/cloud.svg',
    'deepseek-local-preview': '/__assets/deepseek-open.png' });
  const roles = Object.freeze({ cat: 'cat', dog: 'dog', custom: 'cloud' });
  const bubbles = Object.freeze({ idle: '点我聊聊', walking: '慢慢走一会', resting: '休息一会', dragging: '换个地方坐坐' });
  const states = new Set(Object.keys(bubbles));
  const activities = Object.freeze({ idle: '点我聊聊', happy: '见到你真开心', thinking: '让我想一想…', speaking: '正在和你说话' });
  let petId = null;
  let drag = null;
  let disposed = false;
  let updates = 0;
  let unsubscribe = () => {};

  function send(method, ...args) {
    try {
      const result = bridge?.[method]?.(...args);
      if (result && typeof result.catch === 'function') result.catch(() => {});
    } catch {
      // This renderer has no access to content, credentials, or application logs.
    }
  }

  function safeText(value) {
    return typeof value === 'string' ? [...value.replace(/[\u0000-\u001f\u007f]/g, '')].slice(0, 60).join('') : '';
  }

  function applyIdentity(identity) {
    if (disposed || !identity || typeof identity.pet_id !== 'string' || identity.pet_id.length > 100) return;
    if (petId !== null && identity.pet_id !== petId) return;
    petId = identity.pet_id;
    const label = safeText(identity.name) || '桌面伙伴';
    const role = Object.hasOwn(roles, identity.role_type) ? identity.role_type : 'custom';
    const asset = Object.hasOwn(assets, identity.asset_id) ? identity.asset_id : roles[role];
    const state = states.has(identity.state) ? identity.state : 'idle';
    name.textContent = label;
    button.setAttribute('aria-label', '和' + label + '聊天');
    document.title = '萌宠溜达 · ' + label;
    document.body.dataset.petId = petId;
    document.body.dataset.role = role;
    document.body.dataset.assetId = asset;
    if (asset === 'deepseek-local-preview') {
      if (!document.body.dataset.feedback) document.body.dataset.feedback = 'idle';
      if (blink && blink.getAttribute('src') !== '/__assets/deepseek-blink.png') blink.setAttribute('src', '/__assets/deepseek-blink.png');
    }
    document.body.dataset.state = state;
    const activity = Object.hasOwn(activities, identity.activity) ? identity.activity : 'idle';
    document.body.dataset.activity = activity;
    document.body.dataset.direction = identity.direction === 'left' ? 'left' : 'right';
    for (const known of states) document.body.classList.toggle('state-' + known, state === known);
    document.body.classList.toggle('paused', document.hidden || identity.visible === false);
    if (typeof identity.tint === 'string' && /^#[\da-f]{6}$/i.test(identity.tint)) {
      document.documentElement.style.setProperty('--pet-tint', identity.tint);
    }
    bubble.textContent = state === 'dragging' ? bubbles.dragging : safeText(identity.greeting)
      || (activity === 'idle' ? bubbles[state] : activities[activity]);
    const actionHandled = window.weibiyePetActions?.apply(identity);
    if (!actionHandled && art.getAttribute('src') !== assets[asset]) art.setAttribute('src', assets[asset]);
    const social=identity.social;
    document.body.dataset.mood=['happy','calm','curious','angry','upset','sad','shy','sleepy'].includes(social?.mood)?social.mood:'calm';
    document.body.dataset.moodPosture = window.WeiBiYePetMood?.posture(identity, document.hidden) ?? 'none';
    const showSocial=social?.bubble&&social.bubble.until>Date.now()&&!['thinking','speaking'].includes(activity)&&state!=='dragging';
    if(showSocial)bubble.textContent=safeText(social.bubble.text);
    bubble.dataset.source=showSocial?'local-social':'activity';
    button.disabled = false;
  }

  function point(event) {
    if (!Number.isFinite(event.screenX) || !Number.isFinite(event.screenY)) return null;
    return {
      x: Math.max(-100000, Math.min(100000, event.screenX)),
      y: Math.max(-100000, Math.min(100000, event.screenY)),
    };
  }

  function finish(event, cancelled) {
    if (!drag || (event?.pointerId !== undefined && event.pointerId !== drag.pointerId)) return;
    const previous = drag;
    drag = null;
    if (document.body.dataset.assetId === 'deepseek-local-preview') document.body.dataset.feedback = 'idle';
    const finalPoint = event ? point(event) : null;
    if (finalPoint && Math.hypot(finalPoint.x - previous.origin.x, finalPoint.y - previous.origin.y) >= 6) {
      previous.moved = true;
    }
    if (previous.moved && event && !cancelled) {
      if (finalPoint) send('dragMove', finalPoint);
    }
    send('dragEnd');
    if (button.hasPointerCapture(previous.pointerId)) button.releasePointerCapture(previous.pointerId);
    if (!cancelled && !previous.moved) send('chat');
  }

  button.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || drag || !petId) return;
    const origin = point(event);
    if (!origin) return;
    event.preventDefault();
    drag = { pointerId: event.pointerId, origin, moved: false, sentAt: 0 };
    if (document.body.dataset.assetId === 'deepseek-local-preview') document.body.dataset.feedback = 'pressed';
    button.setPointerCapture(event.pointerId);
    send('dragStart', origin);
  }, { signal });

  button.addEventListener('pointermove', (event) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const current = point(event);
    if (!current) return;
    if (!drag.moved && Math.hypot(current.x - drag.origin.x, current.y - drag.origin.y) < 6) return;
    drag.moved = true;
    if (event.timeStamp - drag.sentAt < 16) return;
    drag.sentAt = event.timeStamp;
    send('dragMove', current);
  }, { signal });

  button.addEventListener('pointerup', (event) => finish(event, false), { signal });
  button.addEventListener('pointercancel', (event) => finish(event, true), { signal });
  button.addEventListener('lostpointercapture', (event) => finish(event, true), { signal });
  button.addEventListener('click', (event) => {
    // A keyboard button activation has no pointer sequence; pointerup already handled clicks.
    if (event.detail === 0 && petId && !drag) send('chat');
  }, { signal });
  button.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    finish(null, true);
    if (petId) send('menu');
  }, { signal });
  window.addEventListener('blur', () => finish(null, true), { signal });
  document.addEventListener('visibilitychange', () => {
    document.body.classList.toggle('paused', document.hidden);
    if (document.hidden) document.body.dataset.moodPosture = 'none';
    if (document.hidden) finish(null, true);
  }, { signal });

  function cleanup() {
    if (disposed) return;
    finish(null, true);
    disposed = true;
    unsubscribe();
    controller.abort();
  }
  window.addEventListener('pagehide', cleanup, { signal });
  window.addEventListener('beforeunload', cleanup, { signal });

  if (!bridge || typeof bridge.identity !== 'function') {
    bubble.textContent = '桌面连接尚未就绪';
    return;
  }
  try {
    if (typeof bridge.onState === 'function') {
      unsubscribe = bridge.onState((identity) => { updates += 1; applyIdentity(identity); });
      if (typeof unsubscribe !== 'function') unsubscribe = () => {};
    }
    const initialVersion = updates;
    Promise.resolve(bridge.identity()).then((identity) => {
      if (updates === initialVersion) applyIdentity(identity);
    }).catch(() => { if (!disposed && !petId) bubble.textContent = '暂时无法连接桌面伙伴'; });
  } catch {
    bubble.textContent = '暂时无法连接桌面伙伴';
  }
})();
