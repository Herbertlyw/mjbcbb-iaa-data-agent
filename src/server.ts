import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { DEMO_QUESTIONS } from "./demo.js";
import { RequestError } from "./jobs.js";
import { modelCatalog } from "./model-catalog.js";
import type { Runtime } from "./runtime.js";
import type { JobRecord } from "./types.js";

const indexHtml = readFileSync(new URL("./web/index.html", import.meta.url), "utf8");

export function startServer(runtime: Runtime): Server {
  return createServer((req, res) => {
    void handle(runtime, req, res);
  });
}

async function handle(runtime: Runtime, req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const method = req.method ?? "GET";
    if (method === "GET" && url.pathname === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(indexHtml);
      return;
    }
    if (method === "GET" && url.pathname === "/api/health") {
      send(res, 200, {
        ok: true,
        simulated: true,
        model_mode: runtime.config.modelMode,
        external_model: false,
        remote_dispatch: false,
        model_provider: runtime.config.modelMode === "pi" ? runtime.config.piProvider : "deterministic",
        language_understanding: runtime.config.modelMode === "pi"
          ? runtime.config.piProvider === "faux"
            ? "faux-local-not-external-model"
            : runtime.config.piProvider === "openai-compatible"
              ? "pi-ai-1.1.0-openai-completions-loopback-only"
              : "configured-provider-not-verified-in-this-build"
          : "slot-compiler",
        model_catalog: modelCatalog(runtime.config),
        fallback_to_demo: false,
        demo_limit: "无密钥演示模式只编译登记过的产品、地区、平台、渠道、指标、分组和环比，不是通用语言理解。",
        database: runtime.config.businessEngine === "clickhouse" ? "clickhouse-local-readonly" : "sqlite-local-readonly",
        business_engine: runtime.config.businessEngine,
        state_mode: runtime.config.stateMode,
        state_database: runtime.config.stateMode === "mysql" ? "mysql-local-authority" : "sqlite-local",
        persistence: runtime.config.stateMode === "mysql" ? "mysql-transaction" : "sqlite-single-host",
        queue: runtime.config.stateMode === "mysql" ? "redis-wake-only" : "sqlite-poll",
        production_mysql: false,
        production_redis: false,
        delivery: runtime.config.stateMode === "mysql" ? "at-least-once-dispatch-and-single-terminal-state" : "sqlite-local-loop",
        identity: "local-mock-not-authentication",
        leases: runtime.config.stateMode === "mysql" ? "mysql-fence" : "single-host-fence",
        multi_host: false,
        freshness: "published-snapshot",
        target_gaps: [
          "默认演示进程仍是 SQLite。MySQL、outbox 和 Redis 只在显式的本地隔离模式里运行，不能把 SQLite 测试当成它们的验证。",
          "Redis 只做调度提醒。队列消息不是完成证明，也不是身份证明。",
          "任务执行在崩溃重试时可能再次读取合成库。终态由数据库围栏保证只有一个，外部副作用不是 exactly-once。",
          "身份只是本地 mock 标记，不是生产认证。没有真实模型或线上联调。",
          "远程数据引擎没有实现，新鲜度探测不会连接它们。",
        ],
        crash_recovery: "reclaim-expired-lease",
        scenario: runtime.knowledge.scenario,
      });
      return;
    }
    if (method === "GET" && url.pathname === "/api/demo") {
      send(res, 200, { simulated: true, questions: DEMO_QUESTIONS });
      return;
    }
    if (method === "GET" && url.pathname === "/api/sessions") {
      send(res, 200, {
        sessions: runtime.sessions.list(actorOf(req)).map((session) => ({
          actor_id: session.actor_id ?? "demo-analyst",
          session_id: session.session_id,
          title: session.title,
          role: session.role,
          created_at: session.created_at,
          jobs: runtime.jobs.list(session.session_id).map(publicJob),
        })),
      });
      return;
    }
    if (method === "POST" && url.pathname === "/api/sessions") {
      const body = await readJson(req);
      const actor = actorOf(req);
      const role = actor === "demo-viewer" ? "viewer" : "analyst";
      const session = runtime.sessions.create(role, stringField(body, "title") || "新会话", actor);
      send(res, 201, { session_id: session.session_id, title: session.title, role: session.role, actor_id: session.actor_id, created_at: session.created_at });
      return;
    }
    const sessionMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)$/u);
    if (method === "GET" && sessionMatch?.[1]) {
      const session = ownedSession(runtime, req, decodeURIComponent(sessionMatch[1]));
      send(res, 200, {
        session_id: session.session_id,
        title: session.title,
        role: session.role,
        created_at: session.created_at,
        slots: session.slots,
        jobs: runtime.jobs.list(session.session_id).map(publicJob),
      });
      return;
    }
    const messageMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/messages$/u);
    if (method === "POST" && messageMatch?.[1]) {
      const body = await readJson(req);
      ownedSession(runtime, req, decodeURIComponent(messageMatch[1]));
      const job = runtime.jobs.submit(decodeURIComponent(messageMatch[1]), stringField(body, "text"), stringField(body, "idempotency_key"), {
        modelId: stringField(body, "model_id"),
        reasoning: stringField(body, "reasoning"),
      });
      send(res, 202, publicJob(job));
      return;
    }
    const payloadMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/provider-payloads\/([^/]+)$/u);
    if (method === "GET" && payloadMatch?.[1] && payloadMatch[2]) {
      const session = ownedSession(runtime, req, decodeURIComponent(payloadMatch[1]));
      const offset = Number(url.searchParams.get("offset") ?? "0");
      const limit = Number(url.searchParams.get("limit") ?? "1000");
      const page = runtime.state.readProviderPayload({
        payloadId: decodeURIComponent(payloadMatch[2]),
        actorId: session.actor_id ?? "demo-analyst",
        sessionId: session.session_id,
        offset: Number.isInteger(offset) ? offset : 0,
        limit: Number.isInteger(limit) ? Math.min(limit, 4000) : 1000,
      });
      if (!page) throw new Error("session_not_found");
      send(res, 200, page);
      return;
    }
    const payloadListMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/provider-payloads$/u);
    if (method === "GET" && payloadListMatch?.[1]) {
      const session = ownedSession(runtime, req, decodeURIComponent(payloadListMatch[1]));
      const jobId = url.searchParams.get("job_id") ?? "";
      const job = runtime.jobs.require(jobId);
      if (job.session_id !== session.session_id) throw new Error("session_not_found");
      send(res, 200, { payloads: runtime.state.listProviderPayloads(jobId, session.actor_id ?? "demo-analyst") });
      return;
    }
    const jobMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)$/u);
    if (method === "GET" && jobMatch?.[1]) {
      const job = runtime.jobs.require(decodeURIComponent(jobMatch[1]));
      ownedSession(runtime, req, job.session_id);
      send(res, 200, publicJob(job));
      return;
    }
    const cancelMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)\/cancel$/u);
    if (method === "POST" && cancelMatch?.[1]) {
      const existing = runtime.jobs.require(decodeURIComponent(cancelMatch[1]));
      ownedSession(runtime, req, existing.session_id);
      send(res, 200, publicJob(runtime.jobs.cancel(existing.job_id)));
      return;
    }
    const eventMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)\/events$/u);
    if (method === "GET" && eventMatch?.[1]) {
      const streamed = runtime.jobs.require(decodeURIComponent(eventMatch[1]));
      ownedSession(runtime, req, streamed.session_id);
      streamEvents(runtime, streamed.job_id, url, req, res);
      return;
    }
    send(res, 404, { error: { code: "not_found", message: "没有这个接口" } });
  } catch (error) {
    if (error instanceof RequestError) {
      send(res, error.status, { error: { code: error.code, message: error.message } });
      return;
    }
    if (error instanceof Error && error.message === "session_not_found") {
      send(res, 404, { error: { code: "session_not_found", message: "没有这个会话" } });
      return;
    }
    if (error instanceof SyntaxError) {
      send(res, 400, { error: { code: "invalid_json", message: "请求体不是 JSON" } });
      return;
    }
    send(res, 500, { error: { code: "internal_error", message: error instanceof Error ? error.message : "内部错误" } });
  }
}

function actorOf(req: IncomingMessage): string {
  const header = req.headers["x-demo-actor"];
  const value = Array.isArray(header) ? header[0] : header;
  if (value === "demo-viewer") return "demo-viewer";
  return "demo-analyst";
}

function ownedSession(runtime: Runtime, req: IncomingMessage, sessionId: string) {
  const session = runtime.sessions.require(sessionId);
  if ((session.actor_id ?? "demo-analyst") !== actorOf(req)) throw new Error("session_not_found");
  return session;
}

function streamEvents(runtime: Runtime, jobId: string, url: URL, req: IncomingMessage, res: ServerResponse): void {
  const job = runtime.jobs.require(jobId);
  let cursor = Number(url.searchParams.get("after") ?? 0);
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  const write = (event: { seq: number; type: string }) => {
    if (res.writableEnded || res.destroyed) return false;
    try {
      res.write(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`);
      return true;
    } catch {
      return false;
    }
  };
  const pump = () => {
    const current = runtime.jobs.require(jobId);
    for (const event of current.events) {
      if (event.seq > cursor) {
        cursor = event.seq;
        if (!write(event)) return false;
      }
    }
    return current.status === "queued" || current.status === "running";
  };
  if (!pump()) {
    res.end();
    return;
  }
  const timer = setInterval(() => {
    try {
      if (!pump()) {
        clearInterval(timer);
        res.end();
      }
    } catch {
      clearInterval(timer);
      if (!res.writableEnded) res.end();
    }
  }, 150);
  const close = () => clearInterval(timer);
  req.on("close", close);
  res.on("close", close);
}

function publicJob(job: JobRecord) {
  return {
    job_id: job.job_id,
    session_id: job.session_id,
    status: job.status,
    user_text: job.user_text,
    idempotency_key: job.idempotency_key,
    turn: job.turn,
    events: job.events,
    version: job.version,
    analysis: job.analysis,
    error: job.error,
    usage: job.usage ?? null,
    model_id: job.model_id ?? null,
    reasoning: job.reasoning ?? null,
    simulated: true,
    created_at: job.created_at,
    started_at: job.started_at ?? null,
    finished_at: job.finished_at ?? null,
  };
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text.trim()) return {};
  const value = JSON.parse(text) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function stringField(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  return typeof value === "string" ? value : "";
}
