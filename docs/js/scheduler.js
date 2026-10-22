import { translateBatch, estimateTokens, LiveError } from './live.js';
import { cleanTranslation } from './prompt.js';

const WINDOW_MS = 60_000;
const MAX_ATTEMPTS = 4;
const MAX_QUOTA_RETRIES = 12;

/**
 * Spreads segments over "lanes" (one per API key × engine), keeps each lane
 * under its tokens-per-minute budget, and adapts concurrency to what the
 * server accepts. Fast lanes are served first; slow lanes only take work when
 * there is a real backlog, or when no fast lane is available.
 *
 * Work arrives as jobs (the desk, a batch run); each job has its own prompt
 * and can be paused or cancelled without touching the others. Lanes, and so
 * the per-minute budgets, are shared by every job.
 *
 * Events: 'result' {job, id, text, lang, lane, ms}, 'failed' {job, id, error},
 *         'jobdone' {job}, 'tick', 'fatal' {message, kind}.
 */
export class Scheduler extends EventTarget {
  constructor() {
    super();
    this.lanes = [];
    this.queue = [];
    this.timer = null;
  }

  setLanes(specs) {
    const old = new Map(this.lanes.map((l) => [l.id, l]));
    this.lanes = specs.map((s) => {
      const prev = old.get(s.id);
      // Keep the token log of a lane that survives a settings change.
      return {
        ...s,
        conc: prev?.conc ?? s.engine.startConc,
        inFlight: prev?.inFlight ?? 0,
        log: prev?.log ?? [],
        okStreak: 0,
        backoff: 4000,
        cooldownUntil: prev?.cooldownUntil ?? 0,
        disabled: null,
        done: prev?.done ?? 0,
        tokens: prev?.tokens ?? 0,
        lastError: '',
        waitingQuota: false,
      };
    });
    this.emit('tick');
  }

  createJob({ prompts, detect, priority = false }) {
    return {
      prompts, // { silent, speaking }: system prompts for each kind of engine
      detect,
      priority,
      paused: false,
      inFlight: 0,
      items: new Map(),
      finishedAt: [],
      controller: new AbortController(),
    };
  }

  add(job, segments) {
    const fresh = segments.map((s) => {
      const item = { job, id: s.id, text: s.text, attempts: 0, quotaRetries: 0, state: 'queued' };
      job.items.set(s.id, item);
      return item;
    });
    if (job.priority) this.queue.unshift(...fresh);
    else this.queue.push(...fresh);
    this.wake();
  }

  pauseJob(job) {
    job.paused = true;
    this.emit('tick');
  }

  resumeJob(job) {
    job.paused = false;
    if (job.controller.signal.aborted) job.controller = new AbortController();
    this.wake();
  }

  cancelJob(job) {
    job.paused = true;
    job.controller.abort();
    this.queue = this.queue.filter((it) => it.job !== job);
    for (const it of job.items.values()) if (it.state !== 'done' && it.state !== 'failed') it.state = 'queued';
    this.emit('tick');
  }

  retryFailed(job) {
    const failed = [...job.items.values()].filter((it) => it.state === 'failed');
    for (const it of failed) { it.state = 'queued'; it.attempts = 0; it.quotaRetries = 0; }
    this.queue.push(...failed);
    for (const lane of this.lanes) if (lane.disabled) { lane.disabled = null; lane.conc = lane.engine.startConc; }
    this.resumeJob(job);
    return failed.length;
  }

  queuedFor(job) {
    let n = 0;
    for (const it of this.queue) if (it.job === job) n++;
    return n;
  }

  jobStats(job) {
    const now = Date.now();
    job.finishedAt = job.finishedAt.filter((t) => now - t < 20_000);
    const span = job.finishedAt.length > 1 ? Math.max(5_000, now - job.finishedAt[0]) : 20_000;
    let done = 0;
    let failed = 0;
    for (const it of job.items.values()) {
      if (it.state === 'done') done++;
      else if (it.state === 'failed') failed++;
    }
    return { total: job.items.size, done, failed, queued: this.queuedFor(job), perSecond: job.finishedAt.length / (span / 1000) };
  }

  laneStats() {
    const now = Date.now();
    return this.lanes.map((l) => ({
      id: l.id,
      engine: l.engine,
      keyLabel: l.keyLabel,
      used: this.used(l, now),
      limit: l.engine.tpm,
      inFlight: l.inFlight,
      conc: l.conc,
      done: l.done,
      tokens: l.tokens,
      status: this.status(l, now),
      lastError: l.disabled || l.lastError,
    }));
  }

  // ---- internals -------------------------------------------------------

  emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  wake() {
    if (!this.timer) this.timer = setInterval(() => this.pump(), 400);
    this.pump();
  }

  sleep() {
    clearInterval(this.timer);
    this.timer = null;
  }

  used(lane, now = Date.now()) {
    lane.log = lane.log.filter((e) => now - e.t < WINDOW_MS);
    return lane.log.reduce((sum, e) => sum + e.tokens, 0);
  }

  status(lane, now) {
    if (lane.disabled) return 'disabled';
    if (lane.cooldownUntil > now) return 'resting';
    if (lane.inFlight > 0) return 'writing';
    if (lane.waitingQuota) return 'waiting';
    return 'idle';
  }

  estimate(lane, batch) {
    const input = batch.reduce((n, it) => n + estimateTokens(it.text), 0);
    const output = Math.ceil(input * 1.15);
    const e = lane.engine;
    // Measured: the plain Live engine costs ~1 000 tokens per session plus
    // thinking; the extended-thinking engine carries a ~3 400-token hidden
    // prompt and is billed for two turns (the spoken word, then the call).
    return e.speaks
      ? 2 * (e.overhead + input) + output + 700
      : e.overhead + input + output + Math.ceil(output * 0.9);
  }

  // Next run of queued items from one active job, within the lane's limits.
  peekBatch(lane) {
    const start = this.queue.findIndex((it) => !it.job.paused);
    if (start < 0) return [];
    const job = this.queue[start].job;
    const batch = [];
    let budget = 0;
    for (let k = start; k < this.queue.length && batch.length < lane.engine.batchSize; k++) {
      const it = this.queue[k];
      if (it.job !== job) continue;
      const cost = estimateTokens(it.text);
      if (batch.length && budget + cost > lane.engine.maxInputTokens) break;
      batch.push(it);
      budget += cost;
    }
    return batch;
  }

  fastLaneReady(now) {
    return this.lanes.some((l) => !l.engine.speaks && !l.disabled && l.cooldownUntil <= now);
  }

  activeQueued() {
    let n = 0;
    for (const it of this.queue) if (!it.job.paused) n++;
    return n;
  }

  pump() {
    const now = Date.now();
    const order = [...this.lanes].sort((a, b) => Number(a.engine.speaks) - Number(b.engine.speaks));
    for (const lane of order) {
      lane.waitingQuota = false;
      if (lane.disabled || lane.cooldownUntil > now) continue;
      while (lane.inFlight < lane.conc) {
        const batch = this.peekBatch(lane);
        if (!batch.length) break;
        // A slow lane is worth it only for a real backlog, or as a fallback.
        if (lane.engine.speaks && this.fastLaneReady(now) && this.activeQueued() < lane.engine.batchSize) break;
        if (this.used(lane, now) + this.estimate(lane, batch) > lane.engine.tpm) { lane.waitingQuota = true; break; }
        const taken = new Set(batch);
        this.queue = this.queue.filter((it) => !taken.has(it));
        this.dispatch(lane, batch);
      }
    }
    this.emit('tick');
    const inFlight = this.lanes.some((l) => l.inFlight > 0);
    if (!inFlight && !this.activeQueued()) this.sleep();
    if (!inFlight && this.activeQueued() && this.lanes.length && this.lanes.every((l) => l.disabled)) {
      this.sleep();
      this.emit('fatal', { message: this.lanes[0].disabled, kind: 'disabled' });
    }
  }

  dispatch(lane, batch) {
    const job = batch[0].job;
    const entry = { t: Date.now(), tokens: this.estimate(lane, batch) };
    lane.log.push(entry);
    lane.inFlight += 1;
    job.inFlight += 1;
    for (const it of batch) it.state = 'working';

    translateBatch({
      apiKey: lane.key,
      engine: lane.engine,
      items: batch.map((it, i) => ({ i, text: it.text })),
      systemPrompt: lane.engine.speaks ? job.prompts.speaking : job.prompts.silent,
      detect: job.detect,
      signal: job.controller.signal,
    }).then((res) => {
      entry.tokens = res.partialUsage ? Math.max(entry.tokens, res.tokens * 2) : res.tokens || entry.tokens;
      lane.tokens += entry.tokens;
      lane.okStreak += 1;
      lane.backoff = 4000;
      lane.lastError = '';
      if (lane.okStreak >= 3 && lane.conc < lane.engine.maxConc) { lane.conc += 1; lane.okStreak = 0; }

      const byIndex = new Map(res.items.map((r) => [r.i, r]));
      const missing = [];
      batch.forEach((it, i) => {
        const r = byIndex.get(i);
        if (!r || (!r.t.trim() && it.text.trim())) { missing.push(it); return; }
        it.state = 'done';
        lane.done += 1;
        job.finishedAt.push(Date.now());
        this.emit('result', { job, id: it.id, text: cleanTranslation(r.t, it.text), lang: r.l, lane, ms: res.ms, tokens: entry.tokens });
      });
      if (missing.length) this.retry(missing, new LiveError('Segment missing from the answer.', 'empty'));
    }).catch((err) => {
      if (err.kind === 'aborted') { for (const it of batch) if (it.state === 'working') it.state = 'queued'; return; }
      lane.okStreak = 0;
      lane.lastError = err.message;
      if (err.kind === 'quota') {
        lane.conc = Math.max(1, Math.floor(lane.conc / 2));
        lane.cooldownUntil = Date.now() + lane.backoff;
        lane.backoff = Math.min(lane.backoff * 2, 60_000);
        this.requeue(batch, { quota: true });
      } else if (err.kind === 'auth' || err.kind === 'config') {
        lane.disabled = err.message;
        this.requeue(batch, { free: true });
      } else {
        this.retry(batch, err);
      }
    }).finally(() => {
      lane.inFlight -= 1;
      job.inFlight -= 1;
      if (!job.inFlight && !this.queuedFor(job)) this.emit('jobdone', { job });
      this.pump();
    });
  }

  requeue(batch, { quota = false, free = false }) {
    const back = [];
    for (const it of batch) {
      if (quota && ++it.quotaRetries > MAX_QUOTA_RETRIES) { this.fail(it, 'Quota still exhausted after many retries.'); continue; }
      if (!quota && !free) it.attempts += 1;
      it.state = 'queued';
      back.push(it);
    }
    this.queue.unshift(...back);
  }

  retry(batch, err) {
    const back = [];
    for (const it of batch) {
      if (++it.attempts >= MAX_ATTEMPTS) { this.fail(it, err.message); continue; }
      it.state = 'queued';
      back.push(it);
    }
    this.queue.unshift(...back);
  }

  fail(it, message) {
    it.state = 'failed';
    this.emit('failed', { job: it.job, id: it.id, error: message });
  }
}
