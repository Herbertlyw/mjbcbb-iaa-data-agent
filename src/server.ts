import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { demoForScenario } from "./demo.js";
import { RequestError } from "./jobs.js";
import { modelCatalog } from "./model-catalog.js";
import type { Runtime } from "./runtime.js";
import type { JobRecord } from "./types.js";
import type { StateStore, StoredSession } from "./state-store.js";
import { webAsset } from "./web-assets.js";
import { loadVvDemo } from "./vv-demo.js";
import { HistoryPageError, parseHistoryPage, parseEventAfter } from "./history-page.mjs";
import { streamEventPages } from "./event-stream.js";
import { clearVisitorCookie, hashVisitorCredential, issueVisitorCredential, readVisitorCookie, validVisitorCsrf, validVisitorOrigin, visitorCookie, visitorCsrfToken, visitorOriginSettings } from "./visitor-credentials.js";

const controlledActors = new WeakMap<IncomingMessage, { actor: string; hash: string }>();

export function startServer(runtime: Runtime): Server {
  return createServer((req, res) => {
    void handle(runtime, req, res);
  });
}

async function handle(runtime: Runtime, req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const method = req.method ?? "GET";
    const asset = method === "GET" || method === "HEAD" ? webAsset(url.pathname) : undefined;
    if (asset) {
      res.writeHead(200, { "content-type": asset.contentType, "cache-control": "no-store", "x-content-type-options": "nosniff" });
      res.end(method === "HEAD" ? undefined : asset.body);
      return;
    }
    if (runtime.config.identityMode === "controlled_visitor" && url.pathname.startsWith("/api/")) {
      const origin = visitorOriginSettings(runtime.config.visitorOrigin, runtime.config.visitorAllowLoopbackHttp);
      if (req.headers.host !== origin.host || (req.headers.origin !== undefined && !validVisitorOrigin(origin, req.headers.origin, req.headers.host))) throw new RequestError("invalid_origin", "请求来源无效。", 403);
      if (url.pathname === "/api/visitor/reset" && method === "POST") {
        if (!validVisitorOrigin(origin, req.headers.origin, req.headers.host)) throw new RequestError("invalid_origin", "请求来源无效。", 403);
        await readJson(req, res, {});
        res.setHeader("set-cookie", clearVisitorCookie(origin));
        send(res, 200, { reset: true }); return;
      }
      if (url.pathname === "/api/visitor" && method === "POST") {
        if (!validVisitorOrigin(origin, req.headers.origin, req.headers.host)) throw new RequestError("invalid_origin", "请求来源无效。", 403);
        await readJson(req, res, {});
        const cookie = readVisitorCookie(req.headers.cookie);
        const supplied = /(?:^|;)\s*vv_visitor=/u.test(req.headers.cookie ?? "");
        if (supplied && !cookie) throw new RequestError("visitor_invalid", "访客身份无效，请重新开始。", 401);
        if (cookie) {
          const identity = await stateCall(runtime, "lookupVisitor", hashVisitorCredential(cookie));
          if (!identity) throw new RequestError("visitor_invalid", "访客身份已失效，请重新开始。", 401);
          send(res, 200, { visitor_id: identity.visitor_id, csrf_token: visitorCsrfToken(cookie), expires_at_ms: identity.expires_at_ms }); return;
        }
        const issued = issueVisitorCredential();
        const created = await stateCall(runtime, "createVisitor", { visitorId: issued.visitorId, credentialHash: issued.credentialHash, ttlMs: 7 * 86400000, windowMs: runtime.config.visitorBootstrapWindowMs, maxCreates: runtime.config.visitorBootstrapMaxCreates });
        if (!created) { res.setHeader("retry-after", String(Math.ceil(runtime.config.visitorBootstrapWindowMs/1000))); throw new RequestError("visitor_bootstrap_limited", "访客入口繁忙，请稍后再试。", 429); }
        res.setHeader("set-cookie", visitorCookie(issued.credential, 7 * 86400, origin));
        send(res, 201, { visitor_id: created.visitor_id, csrf_token: issued.csrfToken, expires_at_ms: created.expires_at_ms }); return;
      }
      if (!["/api/health", "/api/demo", "/api/live", "/api/ready"].includes(url.pathname)) {
        const cookie = readVisitorCookie(req.headers.cookie);
        if (!cookie) throw new RequestError(/(?:^|;)\s*vv_visitor=/u.test(req.headers.cookie ?? "") ? "visitor_invalid" : "visitor_missing", "访客身份不可用，请重新开始。", 401);
        const hash = hashVisitorCredential(cookie);
        const identity = await stateCall(runtime, "lookupVisitor", hash);
        if (!identity) throw new RequestError("visitor_invalid", "访客身份已失效，请重新开始。", 401);
        controlledActors.set(req, { actor: identity.visitor_id, hash });
        if (method !== "GET" && method !== "HEAD") {
          if (!validVisitorOrigin(origin, req.headers.origin, req.headers.host) || !validVisitorCsrf(cookie, typeof req.headers["x-csrf-token"] === "string" ? req.headers["x-csrf-token"] : undefined)) throw new RequestError("csrf_rejected", "请求验证失败。", 403);
        }
        if (url.pathname === "/api/visitor" && method === "GET") { send(res, 200, { visitor_id: identity.visitor_id, csrf_token: visitorCsrfToken(cookie), expires_at_ms: identity.expires_at_ms }); return; }
      }
    }
    if (method === "GET" && url.pathname === "/api/live") { send(res, 200, { live: true }); return; }
    if (method === "GET" && url.pathname === "/api/ready") {
      const readiness = await runtime.analysisReadiness();
      send(res, readiness.ready ? 200 : 503, readiness);
      return;
    }
    if (method === "GET" && url.pathname === "/api/health") {
      const freshnessHealth = await runtime.freshnessHealth();
      const deepseekRemote = runtime.config.modelMode === "pi" && runtime.config.piProvider === "deepseek" && runtime.config.allowRemoteHttps && runtime.config.piBaseUrl.startsWith("https://api.deepseek.com");
      send(res, 200, {
        ok: true,
        simulated: true,
        model_mode: runtime.config.modelMode,
        external_model: deepseekRemote ? true : runtime.config.modelMode === "pi" && runtime.config.piProvider === "openai-compatible" && !runtime.config.protocolScript ? null : false,
        model_service: deepseekRemote ? "deepseek-official-unverified" : runtime.config.modelMode !== "pi" ? "deterministic-demo" : runtime.config.piProvider === "faux" ? "faux" : runtime.config.protocolScript ? "scripted-loopback" : "configured-loopback-unverified",
        remote_dispatch: deepseekRemote,
        model_provider: runtime.config.modelMode === "pi" ? runtime.config.piProvider : "deterministic",
        protocol_scripted: runtime.config.modelMode === "pi" && Boolean(runtime.config.protocolScript),
        language_understanding: runtime.config.modelMode === "pi"
          ? runtime.config.piProvider === "faux"
            ? "faux-local-not-external-model"
            : runtime.config.piProvider === "deepseek"
              ? "deepseek-chat-completions-unverified"
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
        identity: runtime.config.identityMode === "controlled_visitor" ? "controlled-visitor-experimental" : "local-mock-not-authentication",
        leases: runtime.config.stateMode === "mysql" ? "mysql-fence" : "single-host-fence",
        multi_host: false,
        freshness: runtime.config.stateMode === "mysql" ? "mysql-published-snapshot" : "sqlite-demo-file-snapshot",
        freshness_status: freshnessHealth.status,
        target_gaps: [
          "默认演示进程仍是 SQLite。MySQL、outbox 和 Redis 只在显式的本地隔离模式里运行，不能把 SQLite 测试当成它们的验证。",
          "Redis 只做调度提醒。队列消息不是完成证明，也不是身份证明。",
          "任务执行在崩溃重试时可能再次读取合成库。终态由数据库围栏保证只有一个，外部副作用不是 exactly-once。",
          runtime.config.identityMode === "controlled_visitor" ? "受控匿名访客为实验功能，并非真人认证或生产上线证明；模型配置不代表能力验证。" : "身份只是本地 mock 标记，不是生产认证；模型配置不代表已完成真实模型能力验证。",
          "远程数据引擎没有实现，新鲜度探测不会连接它们。",
        ],
        crash_recovery: "reclaim-expired-lease",
        scenario: runtime.knowledge.scenario,
      });
      return;
    }
    if (method === "GET" && url.pathname === "/api/demo") {
      const isVv = runtime.knowledge.contract_by_table.has("fact_acquisition_daily") && runtime.knowledge.contract_by_table.has("dim_app");
      const demo = isVv ? await loadVvDemo(runtime.config.knowledgeDir)
        : demoForScenario(runtime.knowledge.contract_by_table.has("fact_fox_daily_install"), runtime.config.demoFixtureToday || undefined);
      send(res, 200, { simulated: true, ...demo });
      return;
    }
    if (method === "GET" && url.pathname === "/api/sessions") {
      const actor = actorOf(req);
      const page = await stateCall(runtime, "listSessionSummaries", actor, parseHistoryPage(url.searchParams, "sessions", actor));
      send(res, 200, { sessions: page.items, has_more: page.has_more, next_cursor: page.next_cursor });
      return;
    }
    if (method === "POST" && url.pathname === "/api/sessions") {
      const body = await readJson(req, res, { title: 200, creation_key: 128 });
      const actor = actorOf(req);
      const role = actor === "demo-viewer" ? "viewer" : "analyst";
      const visitor = controlledActors.get(req);
      const creationKey = stringField(body, "creation_key");
      if (visitor && !creationKey.trim()) throw new RequestError("invalid_request", "创建会话需要幂等键。", 400);
      const session = await stateCall(runtime, "createSession", { session_id: `ses_${randomUUID()}`, title: stringField(body, "title") || "新会话", role, actor_id: actor, created_at: new Date().toISOString(), slots: null, bindings: [] }, ...(visitor ? [{ visitorId: visitor.actor, credentialHash: visitor.hash, creationKey }] as const : []));
      send(res, 201, { session_id: session.session_id, title: session.title, role: session.role, actor_id: session.actor_id, created_at: session.created_at });
      return;
    }
    const sessionMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)$/u);
    if (method === "GET" && sessionMatch?.[1]) {
      const session = await stateCall(runtime, "getSessionMetadata", decodeURIComponent(sessionMatch[1]), actorOf(req));
      if (!session) throw new Error("session_not_found");
      send(res, 200, session);
      return;
    }
    const jobsMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/jobs$/u);
    if (method === "GET" && jobsMatch?.[1]) {
      const id = decodeURIComponent(jobsMatch[1]);
      const actor = actorOf(req);
      const input = parseHistoryPage(url.searchParams, "jobs", `${actor}/${id}`);
      const session = await stateCall(runtime, "getSessionMetadata", id, actor);
      if (!session) throw new Error("session_not_found");
      const page = await stateCall(runtime, "listJobSummaries", id, actor, input);
      send(res, 200, { jobs: page.items, has_more: page.has_more, next_cursor: page.next_cursor, active_job_id: session.active_job_id });
      return;
    }
    const resourceMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/resources\/([^/]+)$/u);
    if (method === "GET" && resourceMatch?.[1] && resourceMatch[2]) {
      const session = await ownedSession(runtime, req, decodeURIComponent(resourceMatch[1]));
      const offset = Number(url.searchParams.get("offset") ?? "0");
      const limit = Number(url.searchParams.get("limit") ?? "50");
      const expected = url.searchParams.get("resource_hash") ?? undefined;
      const page = await runtime.tools.readSessionResource(session.session_id, { resource_id: decodeURIComponent(resourceMatch[2]), row_offset: offset, row_limit: limit, expected_resource_hash: expected });
      if (!page.ok) { send(res, 400, { error: { code: page.code, message: page.message } }); return; }
      send(res, 200, page);
      return;
    }
    const messageMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/messages$/u);
    if (method === "POST" && messageMatch?.[1]) {
      const body = await readJson(req, res, { text: 32_000, idempotency_key: 128, model_id: 128, reasoning: 16 });
      const session = await ownedSession(runtime, req, decodeURIComponent(messageMatch[1]));
      const selection = {
        modelId: stringField(body, "model_id"),
        reasoning: stringField(body, "reasoning"),
      };
      let admission;
      if (runtime.config.identityMode === "controlled_visitor") {
        const visitor = controlledActors.get(req);
        if (!visitor) throw new RequestError("visitor_invalid", "访客身份不可用。", 401);
        const requestHash = createHash("sha256").update(JSON.stringify([session.session_id, stringField(body, "text").trim(), selection.modelId, selection.reasoning])).digest("hex");
        admission = { visitorId: visitor.actor, credentialHash: visitor.hash, requestHash };
        const replay = await stateCall(runtime, "recoverVisitorSubmission", session.session_id, admission, stringField(body, "idempotency_key"));
        if (replay) { send(res, 200, await publicJob(runtime, replay)); return; }
        if (!(await runtime.analysisReadiness()).ready) throw new RequestError("analysis_not_ready", "分析服务尚未就绪；历史仍可查看，请稍后手动重试。", 503);
      }
      const job = runtime.config.stateMode === "mysql"
        ? await runtime.jobs.submitAsync(await runtime.mysqlAsyncState(), session, stringField(body, "text"), stringField(body, "idempotency_key"), selection, admission)
        : runtime.jobs.submit(session.session_id, stringField(body, "text"), stringField(body, "idempotency_key"), selection);
      send(res, 202, await publicJob(runtime, job));
      return;
    }
    const payloadMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/provider-payloads\/([^/]+)$/u);
    if (method === "GET" && payloadMatch?.[1] && payloadMatch[2]) {
      const session = await ownedSession(runtime, req, decodeURIComponent(payloadMatch[1]));
      const offset = Number(url.searchParams.get("offset") ?? "0");
      const limit = Number(url.searchParams.get("limit") ?? "1000");
      const page = await stateCall(runtime, "readProviderPayload", {
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
      const session = await ownedSession(runtime, req, decodeURIComponent(payloadListMatch[1]));
      const jobId = url.searchParams.get("job_id") ?? "";
      const job = await requireOwnedJob(runtime, req, jobId);
      if (job.session_id !== session.session_id) throw new Error("session_not_found");
      send(res, 200, { payloads: await stateCall(runtime, "listProviderPayloads", jobId, session.actor_id ?? "demo-analyst") });
      return;
    }
    const jobMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)$/u);
    if (method === "GET" && jobMatch?.[1]) {
      const job = await requireOwnedJob(runtime, req, decodeURIComponent(jobMatch[1]));
      send(res, 200, await publicJob(runtime, job));
      return;
    }
    const cancelMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)\/cancel$/u);
    if (method === "POST" && cancelMatch?.[1]) {
      const existing = await requireOwnedJob(runtime, req, decodeURIComponent(cancelMatch[1]));
      const cancelled = await stateCall(runtime, "requestCancel", existing.job_id);
      runtime.jobs.abortLocal(existing.job_id);
      send(res, 200, await publicJob(runtime, cancelled));
      return;
    }
    const eventMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)\/events$/u);
    if (method === "GET" && eventMatch?.[1]) {
      const after = parseEventAfter(url.searchParams);
      const id = decodeURIComponent(eventMatch[1]);
      const head = await stateCall(runtime, "getJobHead", id);
      if (!head) throw new RequestError("job_not_found", "没有这个任务", 404);
      if (!await stateCall(runtime, "getSessionMetadata", head.session_id, actorOf(req))) throw new RequestError("job_not_found", "没有这个任务", 404);
      const first = await stateCall(runtime, "readJobEvents", id, after);
      if (!first) throw new RequestError("job_not_found", "没有这个任务", 404);
      let lastChecked = Date.now();
      await streamEventPages(res, first, after, async (cursor) => {
        const visitor = controlledActors.get(req);
        if (visitor && Date.now() - lastChecked >= 1000) {
          const active = await stateCall(runtime, "lookupVisitor", visitor.hash);
          if (!active || active.visitor_id !== visitor.actor) throw new Error("visitor_expired");
          lastChecked = Date.now();
        }
        const page = await stateCall(runtime, "readJobEvents", id, cursor);
        if (!page) throw new Error("job_not_found");
        return page;
      });
      return;
    }
    send(res, 404, { error: { code: "not_found", message: "没有这个接口" } });
  } catch (error) {
    if (error instanceof Error && error.name === "visitor_session_limit") { send(res, 429, { error: { code: "visitor_session_limit", message: "访客会话创建已达上限，请稍后重试或继续已有会话。" } }); return; }
    if (error instanceof Error && error.name === "idempotency_conflict") { send(res, 409, { error: { code: "idempotency_conflict", message: "幂等键对应不同的请求。" } }); return; }
    if (error instanceof Error && error.name === "visitor_receipt_missing") { send(res, 409, { error: { code: "visitor_receipt_missing", message: "旧任务没有可验证的准入记录，不能作为本次提交恢复。" } }); return; }
    if (error instanceof Error && ["visitor_required", "visitor_expired"].includes(error.name)) { send(res, 401, { error: { code: error.name, message: "访客身份已失效。" } }); return; }
    const code = error instanceof Error ? error.name.startsWith("invalid_") || error.name.startsWith("event_") ? error.name : error.message : "";
    if (error instanceof HistoryPageError || ["invalid_history_page", "invalid_history_cursor", "invalid_event_cursor", "event_cursor_ahead", "event_too_large", "event_sequence_gap"].includes(code)) {
      send(res, code === "event_too_large" || code === "event_sequence_gap" ? 503 : 400, { error: { code, message: "分页或事件游标无效，请刷新后重试。" } });
      return;
    }
    if (["mysql_state_overloaded", "mysql_state_closed", "mysql_state_outcome_unknown", "mysql_state_operation_failed"].includes(code)) {
      send(res, 503, { error: { code: "state_unavailable", message: "状态服务暂不可用，请稍后重试读取；已提交的操作可能仍已保存。" } });
      return;
    }
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
    send(res, 500, { error: { code: "internal_error", message: "内部操作失败，请检查本机服务状态。" } });
  }
}

function actorOf(req: IncomingMessage): string {
  const visitor = controlledActors.get(req);
  if (visitor) return visitor.actor;
  const header = req.headers["x-demo-actor"];
  const value = Array.isArray(header) ? header[0] : header;
  if (value === "demo-viewer") return "demo-viewer";
  return "demo-analyst";
}

async function stateCall<K extends Exclude<keyof StateStore, "close">>(runtime: Runtime, op: K, ...args: Parameters<StateStore[K]>): Promise<ReturnType<StateStore[K]>> {
  if (runtime.config.stateMode === "mysql") return await (await runtime.mysqlAsyncState()).call(op, ...args) as ReturnType<StateStore[K]>;
  const operation = runtime.state[op] as (...args: Parameters<StateStore[K]>) => ReturnType<StateStore[K]>;
  return operation.apply(runtime.state, args);
}

async function requireJob(runtime: Runtime, jobId: string): Promise<JobRecord> {
  const job = await stateCall(runtime, "getJob", jobId);
  if (!job) throw new RequestError("job_not_found", "没有这个任务", 404);
  return job;
}

async function requireOwnedJob(runtime: Runtime, req: IncomingMessage, jobId: string): Promise<JobRecord> {
  const head = await stateCall(runtime, "getJobHead", jobId);
  if (!head || !await stateCall(runtime, "getSessionMetadata", head.session_id, actorOf(req))) throw new RequestError("job_not_found", "没有这个任务", 404);
  return requireJob(runtime, jobId);
}

async function ownedSession(runtime: Runtime, req: IncomingMessage, sessionId: string): Promise<StoredSession> {
  const session = await stateCall(runtime, "getSession", sessionId);
  if (!session) throw new Error("session_not_found");
  if ((session.actor_id ?? "demo-analyst") !== actorOf(req)) throw new Error("session_not_found");
  return session;
}

async function publicJob(runtime: Runtime, job: JobRecord) {
  const candidate = ["failed", "timed_out", "cancelled"].includes(job.status) ? null : job.analysis;
  const readable = !candidate || await runtime.tools.canReadStoredAnalysis(job.session_id, candidate);
  return {
    job_id: job.job_id,
    session_id: job.session_id,
    status: job.status,
    user_text: job.user_text,
    idempotency_key: job.idempotency_key,
    turn: job.turn,
    events: job.events,
    version: job.version,
    // Historic records are not rewritten. Do not present an old candidate as
    // a delivered answer when its task ultimately failed, timed out or cancelled.
    analysis: readable ? candidate : null,
    error: readable ? job.error : { code: "analysis_access_changed", message: "当前权限或契约已变化，历史分析暂不可显示；保存的记录没有被删除。" },
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

const MAX_JSON_BODY_BYTES = 65_536;

async function readJson(req: IncomingMessage, res: ServerResponse, fields: Record<string, number>): Promise<Record<string, unknown>> {
  const contentType = req.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    req.pause();
    res.setHeader("connection", "close");
    throw new RequestError("unsupported_content_type", "请使用 JSON 请求。", 415);
  }
  const rejectTooLarge = (): never => {
    // Stop consuming an unbounded stream and close this connection after the
    // error response; do not destroy the socket before the client gets 413.
    req.pause();
    res.setHeader("connection", "close");
    throw new RequestError("request_too_large", "请求内容过长。", 413);
  };
  const length = req.headers["content-length"];
  if (length && /^\d+$/u.test(length) && Number(length) > MAX_JSON_BODY_BYTES) rejectTooLarge();
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > MAX_JSON_BODY_BYTES) rejectTooLarge();
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  const value = JSON.parse(text) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new RequestError("invalid_request", "请求内容必须是 JSON 对象。", 400);
  const object = value as Record<string, unknown>;
  for (const [key, entry] of Object.entries(object)) {
    if (!Object.hasOwn(fields, key) || typeof entry !== "string" || entry.length > fields[key]!) {
      throw new RequestError("invalid_request", "请求字段无效或过长。", 400);
    }
  }
  return object;
}

function stringField(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  return typeof value === "string" ? value : "";
}
