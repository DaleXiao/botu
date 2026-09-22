// worker/src/index.js — SPEC-435/T-736 v5：companion worker，承载 JobRunner DO 执行体。
// 为什么是 companion worker：CF 官方文档（pages/functions/wrangler-configuration，2026-06-25）——
// "You cannot create and deploy a Durable Object within a Pages project"；Pages 侧 DO binding
// 必须带 script_name 指向本 worker（spec §方案A 的 DO 数据流不变，仅宿主位置按文档落地）。
// 数据流：Pages POST /api/generate → stub.fetch(x-botu-job/x-botu-ip) → fetch handler 存 meta +
// setAlarm(立即) → alarm handler：幂等 guard → attempts 上限 → img:<id> → runJob（5min 硬超时
// abort）→ 终态写 KV → counted 恰一次 → 删 img → storage.deleteAll()（终态后不再 setAlarm）。
import {
  jobRead, jobWrite, imgKey, imgRead, runJob, JOB_HARD_TIMEOUT_MS, MAX_JOB_ATTEMPTS,
} from '../../lib/jobcore.js';

const JOB_ID_RE = /^[0-9a-f]{32,64}$/i;

export class JobRunner {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  // 触发入口：Pages POST 内 stub.fetch —— 只存 meta + setAlarm，毫秒级返回（不占 POST 响应时间）
  async fetch(request) {
    const jobId = request.headers.get('x-botu-job') || '';
    const ip = request.headers.get('x-botu-ip') || '';
    if (!JOB_ID_RE.test(jobId)) return new Response('invalid job id', { status: 400 });
    await this.state.storage.put('job', { jobId, ip, armedAt: Date.now() });
    await this.state.storage.setAlarm(Date.now());
    return new Response(null, { status: 204 });
  }

  // alarm 主体：invocation 内 await I/O 不受 waitUntil 30s 取消（W1 spike 实证 elapsedMs=95000）
  async alarm() {
    const meta = await this.state.storage.get('job');
    if (!meta || typeof meta.jobId !== 'string' || !JOB_ID_RE.test(meta.jobId)) {
      await this.state.storage.deleteAll();
      return;
    }
    const { jobId, ip } = meta;
    const attempts = (Number(await this.state.storage.get('attempts')) || 0) + 1;
    await this.state.storage.put('attempts', attempts);

    // 幂等 guard：job 已终态（alarm at-least-once 重投 / 双触发）→ 直接收尾，防双扣
    const cur = await jobRead(this.env, jobId);
    if (cur && (cur.state === 'done' || cur.state === 'error')) {
      await this.finish(jobId);
      return;
    }
    // attempts 上限（spec：≥3 → error 终态停止重试）；cur 缺失（job TTL 过期）不重建记录
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
      // runJob：成功 → done + counted 恰一次 + rlWrite；失败/abort 超时 → error 终态（已脱敏），不扣
      await runJob(this.env, { jobId, ip, image_base64: img.image_base64, mime: img.mime }, { signal: ac.signal });
    } finally {
      clearTimeout(timer);
    }
    await this.finish(jobId);
  }

  // 终态收尾：删 img:<id>（成功/失败一律清载荷；img TTL 1h 兜底）+ storage.deleteAll()，不再 setAlarm
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
