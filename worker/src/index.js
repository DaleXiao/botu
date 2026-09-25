// worker/src/index.js — SPEC-435/T-736 v5: companion worker hosting the JobRunner DO executor.
// Why a companion worker: official CF docs (pages/functions/wrangler-configuration, 2026-06-25) —
// "You cannot create and deploy a Durable Object within a Pages project"; the Pages-side DO binding
// must carry script_name pointing at this worker (the DO data flow from spec §Plan A is unchanged; only the host location follows the docs).
// Data flow: Pages POST /api/generate → stub.fetch(x-botu-job/x-botu-ip) → fetch handler stores meta +
// setAlarm(immediate) → alarm handler: idempotency guard → attempts cap → img:<id> → runJob (5min hard-timeout
// abort) → terminal state to KV → counted exactly once → delete img → storage.deleteAll() (no further setAlarm after the terminal state).
import {
  jobRead, jobWrite, imgKey, imgRead, runJob, JOB_HARD_TIMEOUT_MS, MAX_JOB_ATTEMPTS,
} from '../../lib/jobcore.js';

const JOB_ID_RE = /^[0-9a-f]{32,64}$/i;

export class JobRunner {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  // Trigger entry: stub.fetch inside the Pages POST — only stores meta + setAlarm and returns in milliseconds (no cost to the POST response time)
  async fetch(request) {
    const jobId = request.headers.get('x-botu-job') || '';
    const ip = request.headers.get('x-botu-ip') || '';
    if (!JOB_ID_RE.test(jobId)) return new Response('invalid job id', { status: 400 });
    await this.state.storage.put('job', { jobId, ip, armedAt: Date.now() });
    await this.state.storage.setAlarm(Date.now());
    return new Response(null, { status: 204 });
  }

  // Alarm body: awaiting I/O inside the invocation is not subject to the waitUntil 30s cancellation (W1 spike proved elapsedMs=95000)
  async alarm() {
    const meta = await this.state.storage.get('job');
    if (!meta || typeof meta.jobId !== 'string' || !JOB_ID_RE.test(meta.jobId)) {
      await this.state.storage.deleteAll();
      return;
    }
    const { jobId, ip } = meta;
    const attempts = (Number(await this.state.storage.get('attempts')) || 0) + 1;
    await this.state.storage.put('attempts', attempts);

    // Idempotency guard: the job is already terminal (alarm at-least-once redelivery / double trigger) → finish directly, preventing double charging
    const cur = await jobRead(this.env, jobId);
    if (cur && (cur.state === 'done' || cur.state === 'error')) {
      await this.finish(jobId);
      return;
    }
    // Attempts cap (spec: ≥3 → error terminal state, stop retrying); if cur is missing (job TTL expired), do not recreate the record
    if (attempts >= MAX_JOB_ATTEMPTS) {
      if (cur) await jobWrite(this.env, jobId, { state: 'error', error: 'generation failed after retries', ip });
      await this.finish(jobId);
      return;
    }
    const img = await imgRead(this.env, jobId);
    if (!img || typeof img.image_base64 !== 'string') {
      if (cur) await jobWrite(this.env, jobId, { state: 'error', error: 'job input expired', ip });
      await this.finish(jobId);
      return;
    }

    const timeoutMs = Number(this.env.__JOB_HARD_TIMEOUT_MS) > 0
      ? Number(this.env.__JOB_HARD_TIMEOUT_MS)
      : JOB_HARD_TIMEOUT_MS;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      // runJob: success → done + counted exactly once + rlWrite; failure/abort timeout → error terminal state (already sanitized), no charge
      await runJob(this.env, { jobId, ip, image_base64: img.image_base64, mime: img.mime }, { signal: ac.signal });
    } finally {
      clearTimeout(timer);
    }
    await this.finish(jobId);
  }

  // Terminal cleanup: delete img:<id> (the payload is always cleared on success or failure; the img TTL of 1h is the backstop) + storage.deleteAll(), no further setAlarm
  async finish(jobId) {
    try {
      if (this.env.BOTU_RL && typeof this.env.BOTU_RL.delete === 'function') {
        await this.env.BOTU_RL.delete(imgKey(jobId));
      }
    } catch (e) {
      console.error('img delete failed:', String(e).slice(0, 200));
    }
    await this.state.storage.deleteAll();
  }
}

export default {
  async fetch() {
    return new Response('botu-job-runner ok');
  },
};
