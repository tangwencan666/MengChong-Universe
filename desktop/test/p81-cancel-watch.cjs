'use strict';

// Test-only function, evaluated inside the authenticated Electron renderer.
// Its extra GET reads the persisted SSE journal; it never creates a generation.
module.exports = async function watchCancellation(input) {
  class WatchError extends Error {}
  const require = (condition, message) => { if (!condition) throw new WatchError(message); };
  for (const value of [input.petId, input.sessionId, input.generationId, input.messageId]) {
    require(typeof value === 'string' && /^[a-f0-9-]{36}$/.test(value), 'P81 invalid cancellation identity');
  }
  require(Number.isFinite(input.timeoutMs) && input.timeoutMs > 0 && input.timeoutMs <= 45000,
    'P81 invalid cancellation deadline');
  const route = '/api/v1/pets/' + input.petId + '/sessions/' + input.sessionId
    + '/generations/' + input.generationId + '/events';
  const viewPath = '/pets/' + input.petId + '/chat/' + input.sessionId;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs);
  const result = { mechanism: 'generation-journal-sse/1', stopClicked: false,
    firstDeltaReceivedAt: null, stopClickedAt: null, terminalReceivedAt: null,
    firstDeltaSequence: null, terminalSequence: null, events: [] };
  let firstText = '', joined = '', sequence = 0, terminal = null, reader;
  function clickWhenVisible() {
    if (result.stopClicked || terminal || !firstText || window.location.pathname !== viewPath) return;
    const paragraphs = document.querySelectorAll('[role="log"] .message-assistant .message-body > p');
    const text = paragraphs[paragraphs.length - 1]?.textContent ?? '';
    const button = document.querySelector('button[aria-label="停止生成"]');
    if (!button || button.disabled || !text.includes(firstText)) return;
    result.stopClicked = true;
    result.stopClickedAt = new Date().toISOString();
    button.click();
  }
  const observer = new MutationObserver(clickWhenVisible);
  observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
  let buffer = '', fields = { event: '', id: '', data: [] };
  function line(value) {
    if (value.startsWith(':')) return;
    if (value !== '') {
      const separator = value.indexOf(':');
      const name = separator < 0 ? value : value.slice(0, separator);
      const content = separator < 0 ? '' : value.slice(separator + 1).replace(/^ /, '');
      if (name === 'data') fields.data.push(content);
      else if (name === 'event' || name === 'id') fields[name] = content;
      require(fields.data.join('\n').length <= 65536, 'P81 SSE frame exceeds limit');
      return;
    }
    if (!fields.data.length) { fields = { event: '', id: '', data: [] }; return; }
    require(!terminal, 'P81 event appended after terminal');
    let data;
    try { data = JSON.parse(fields.data.join('\n')); }
    catch { throw new WatchError('P81 invalid SSE JSON'); }
    require(data.version === 1 && data.scope === 'generation'
      && data.pet_id === input.petId && data.session_id === input.sessionId
      && data.generation_id === input.generationId && data.message_id === input.messageId,
    'P81 SSE identity mismatch');
    require(Number.isInteger(data.sequence) && data.sequence === sequence + 1
      && fields.id === input.generationId + ':' + data.sequence, 'P81 SSE sequence mismatch');
    sequence = data.sequence;
    const event = fields.event;
    require(['start', 'delta', 'completed', 'cancelled', 'error'].includes(event)
      && (event === 'start') === (sequence === 1), 'P81 invalid SSE event');
    result.events.push({ type: event, sequence, occurredAt: data.occurred_at });
    require(result.events.length <= 1024, 'P81 too many SSE events');
    fields = { event: '', id: '', data: [] };
    if (event === 'delta') {
      require(typeof data.text === 'string' && data.text.length > 0, 'P81 empty SSE delta');
      joined += data.text;
      if (!firstText) {
        firstText = data.text;
        result.firstDeltaSequence = sequence;
        result.firstDeltaReceivedAt = new Date().toISOString();
      }
      clickWhenVisible();
    } else if (event !== 'start') {
      require(event !== 'error', 'P81 generation failed during cancellation acceptance');
      require(data.state === event && typeof data.content === 'string' && data.content === joined,
        'P81 terminal content or state mismatch');
      terminal = event;
      result.state = event;
      result.content = data.content;
      result.terminalSequence = sequence;
      result.terminalReceivedAt = new Date().toISOString();
      observer.disconnect();
    }
  }
  try {
    const response = await fetch(route, { credentials: 'include', signal: controller.signal });
    require(response.status === 200 && response.body
      && response.headers.get('content-type')?.includes('text/event-stream'), 'P81 SSE subscription rejected');
    reader = response.body.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { value, done } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      require(buffer.length <= 65536, 'P81 SSE buffer exceeds limit');
      while (true) {
        const index = buffer.search(/[\r\n]/);
        if (index < 0 || (!done && buffer[index] === '\r' && index === buffer.length - 1)) break;
        const separator = buffer[index] === '\r' && buffer[index + 1] === '\n' ? 2 : 1;
        const value = buffer.slice(0, index);
        buffer = buffer.slice(index + separator);
        line(value);
      }
      if (done) break;
    }
    require(terminal && result.firstDeltaSequence !== null, 'P81 stream ended without delta and terminal');
    result.deltaJoinMatchesFinal = true;
    return result;
  } catch (error) {
    if (error instanceof WatchError) throw error;
    throw new WatchError('P81 cancellation event watch interrupted');
  } finally {
    clearTimeout(timer);
    observer.disconnect();
    controller.abort();
    if (reader) await reader.cancel().catch(() => {});
  }
};
