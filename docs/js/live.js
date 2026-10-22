import { DELIVER, deliverTool, userTurn } from './prompt.js';

const ENDPOINT = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';

export class LiveError extends Error {
  constructor(message, kind, code) {
    super(message);
    this.kind = kind; // quota | auth | config | network | timeout | empty | aborted
    this.code = code;
  }
}

function classify(code, reason) {
  const r = String(reason || '');
  if (/quota|exceeded|RESOURCE_EXHAUSTED|rate limit|too many/i.test(r)) return 'quota';
  if (/api key|API_KEY|PERMISSION_DENIED|unauthori[sz]ed|forbidden|not authorized/i.test(r)) return 'auth';
  if (code === 1007 || code === 1003 || /not found|not supported|invalid/i.test(r)) return 'config';
  return 'network';
}

async function readFrame(data) {
  if (typeof data === 'string') return JSON.parse(data);
  if (data && typeof data.text === 'function') return JSON.parse(await data.text());
  return JSON.parse(new TextDecoder().decode(data));
}

/**
 * Translate one batch of segments over a single Live session.
 * engine: { model, speaks, thinkingLevel, timeoutMs }
 * items:  [{ i, text }]
 * Resolves to { items: [{ i, t, l }], tokens, partialUsage, ms }.
 */
export function translateBatch({ apiKey, engine, items, systemPrompt, detect, signal }) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    let tokens = 0;
    let turns = 0;
    let delivered = null;
    let settled = false;
    let lingerTimer = null;

    let ws = null;

    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(lingerTimer);
      signal?.removeEventListener('abort', onAbort);
      try { ws?.close(1000); } catch { /* already closed */ }
      err ? reject(err) : resolve(value);
    };
    const done = () => finish(null, {
      items: delivered,
      tokens,
      // A speaking engine is cut off right after its function call, so the
      // usage report for that turn never arrives: the caller should estimate.
      partialUsage: engine.speaks,
      ms: Date.now() - t0,
    });

    const timer = setTimeout(() => finish(new LiveError('No answer before the time limit.', 'timeout')), engine.timeoutMs || 45000);
    const onAbort = () => finish(new LiveError('Stopped.', 'aborted'));
    if (signal?.aborted) return onAbort();
    signal?.addEventListener('abort', onAbort);
    ws = new WebSocket(`${ENDPOINT}?key=${encodeURIComponent(apiKey)}`);

    ws.onopen = () => {
      const generationConfig = { responseModalities: ['AUDIO'], temperature: 0.2 };
      if (engine.thinkingLevel) generationConfig.thinkingConfig = { thinkingLevel: engine.thinkingLevel };
      ws.send(JSON.stringify({
        setup: {
          model: `models/${engine.model}`,
          generationConfig,
          systemInstruction: { parts: [{ text: systemPrompt }] },
          tools: [deliverTool(detect)],
        },
      }));
    };

    ws.onmessage = async (ev) => {
      let msg;
      try { msg = await readFrame(ev.data); } catch { return; }
      if (settled) return;

      if (msg.setupComplete) {
        ws.send(JSON.stringify({
          clientContent: { turns: [{ role: 'user', parts: [{ text: userTurn(items) }] }], turnComplete: true },
        }));
        return;
      }
      if (msg.usageMetadata) {
        const u = msg.usageMetadata;
        tokens += (u.totalTokenCount || 0) + (u.thoughtsTokenCount || 0);
      }
      if (msg.toolCall) {
        const call = (msg.toolCall.functionCalls || []).find((fc) => fc.name === DELIVER);
        const list = call?.args?.items;
        if (!Array.isArray(list)) return finish(new LiveError('The model called the function without items.', 'empty'));
        delivered = list.map((it) => ({ i: Number(it.i), t: String(it.t ?? ''), l: it.l ? String(it.l) : undefined }));
        if (engine.speaks) return done();
        // The silent engine reports usage a moment later; wait for it briefly.
        lingerTimer = setTimeout(done, 1500);
        return;
      }
      if (msg.serverContent?.turnComplete) {
        turns += 1;
        if (delivered) return done();
        // A speaking engine first says a short word, then calls the function in a later turn.
        if (!engine.speaks || turns >= 3) finish(new LiveError('The model answered without calling the function.', 'empty'));
      }
    };

    ws.onerror = () => { /* the close event carries the details */ };
    ws.onclose = (ev) => {
      if (settled) return;
      if (delivered) return done();
      const kind = classify(ev.code, ev.reason);
      const reason = ev.reason || (ev.code === 1006 ? 'Connection lost.' : `Closed (${ev.code}).`);
      finish(new LiveError(reason, kind, ev.code));
    };
  });
}

// Rough token estimate, tuned on Armenian and English posts sent as JSON.
export function estimateTokens(text) {
  let ascii = 0;
  let other = 0;
  for (const ch of String(text)) (ch.charCodeAt(0) < 128 ? ascii++ : other++);
  return Math.ceil(ascii * 0.3 + other * 0.62) + 8;
}
