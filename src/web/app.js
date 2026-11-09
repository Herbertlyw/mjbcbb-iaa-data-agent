// Coordinate navigation and requests; rendering and stream ownership are separate modules.
import { labels, renderJob, escapeHtml, displayCell, alignmentRowHtml, updatePaginationCount } from "./view.js";
import { createJobStream } from "./stream.js";
import { mountExamples, releaseDescription } from "./examples.js";
import { createHistoryPager } from "./history.js";

const $ = (selector) => document.querySelector(selector);
const state = {
  sessionId: null,
  job: null,
  runningJobId: null,
  events: [],
  models: [],
  ready: false,
  busy: false,
  navigation: 0,
  detailLoading: false,
  detailRetry: null,
  streamJobId: null,
  activity: 0,
  placeholder: "描述你想了解的指标、范围和时间…",
  visitorCsrf: null,
  controlledIdentity: false,
  visitorId: "local_mock",
  pendingSubmission: null,
};
const question = $("#question");
const result = $("#result");
const notice = $("#connection-notice");
const sessionsPager = createHistoryPager({
  key: "session_id",
  fetchPage: async (_, cursor) => {
    const page = await api(`/api/sessions${pageQuery(cursor)}`);
    return { ...page, items: page.sessions };
  },
  onChange: renderSessions,
});
const historyPager = createHistoryPager({
  key: "job_id",
  fetchPage: async (sessionId, cursor) => {
    const activity = state.activity;
    const page = await api(`/api/sessions/${encodeURIComponent(sessionId)}/jobs${pageQuery(cursor)}`);
    return { ...page, items: page.jobs, activity };
  },
  onPage: (page) => {
    if (page.activity === state.activity) state.runningJobId = page.active_job_id;
  },
  onChange: renderHistory,
});
const stream = createJobStream({
  createSource: (url) => new EventSource(url),
  schedule: (callback, ms) => setTimeout(callback, ms),
  cancelSchedule: (timer) => clearTimeout(timer),
  onConnection: (status) => {
    if (state.job?.job_id !== state.streamJobId) {
      $("#stream-status").textContent = state.runningJobId ? "当前会话另有任务运行，可查看进行中的任务。" : "";
      return;
    }
    $("#stream-status").textContent =
      status === "reconnecting" ? "连接中断，正在续读进度…" : status === "connected" ? "进度已连接" : "";
  },
  onEvent: (event) => {
    if (state.job?.job_id !== state.streamJobId) return;
    if (!state.events.some((item) => item.seq === event.seq)) state.events.push(event);
    renderEvents();
    if (event.type === "job_started") setStatus("running");
  },
  onTerminal: async (jobId) => {
    const sessionId = state.sessionId;
    const job = await api(`/api/jobs/${encodeURIComponent(jobId)}`);
    if (state.sessionId !== sessionId) return;
    state.activity++;
    if (state.runningJobId === jobId) state.runningJobId = null;
    if (state.job?.job_id === jobId) showJob(job);
    historyPager.upsert(jobSummary(job));
    void sessionsPager.load({ refresh: true });
    updateControls();
  },
});

async function api(url, options = {}) {
  const method = (options.method || "GET").toUpperCase();
  const headers = new Headers(options.headers || {});
  if (state.visitorCsrf && !["GET", "HEAD"].includes(method)) headers.set("x-csrf-token", state.visitorCsrf);
  const response = await fetch(url, { ...options, headers });
  const body = await response.json();
  if (!response.ok) {
    if (response.status === 401 && state.controlledIdentity) {
      state.visitorCsrf = null;
      state.ready = false;
      stream.stop();
      $("#visitor-reset").hidden = false;
    }
    const error = new Error(body.error?.message || `服务请求失败（${response.status}）`);
    error.status = response.status;
    error.code = body.error?.code;
    throw error;
  }
  return body;
}

function run(action) {
  return Promise.resolve()
    .then(action)
    .catch((error) => {
      notice.hidden = false;
      notice.textContent =
        error instanceof TypeError
          ? "无法连接本地服务，请确认服务正在运行后重试。"
          : error.message || "操作失败，请重试。";
    })
    .finally(updateControls);
}

function updateControls() {
  const unavailable = !state.ready || state.busy;
  $("#ask").disabled = unavailable || state.detailLoading || Boolean(state.runningJobId);
  $("#new-session").disabled = unavailable;
  $("#cancel").hidden = !state.runningJobId;
  $("#cancel").disabled = state.busy;
  $("#model").disabled = unavailable || Boolean(state.runningJobId);
  $("#reasoning").disabled = unavailable || Boolean(state.runningJobId);
  question.disabled = !state.ready;
  result.setAttribute(
    "aria-busy",
    String(Boolean(state.runningJobId && state.job?.job_id === state.runningJobId)),
  );
  for (const button of document.querySelectorAll("#sessions button, #history button, #prompts button, #example-categories button, #use-example"))
    button.disabled = unavailable;
  $("#active-job").hidden = !state.runningJobId || state.runningJobId === state.job?.job_id;
  $("#active-job").disabled = unavailable;
}

function rememberSession(id) {
  try {
    sessionStorage.setItem("lumenfox-session", id);
  } catch {
    /* The server remains authoritative if browser storage is unavailable. */
  }
}

function setStatus(status) {
  for (const badge of document.querySelectorAll("#status, #result .result-heading .status")) {
    badge.hidden = !status;
    badge.className = `status ${Object.hasOwn(labels, status) ? status : "queued"}`;
    badge.textContent = labels[status] || "";
  }
}

function pageQuery(cursor) {
  const params = new URLSearchParams({ limit: "25" });
  if (cursor) params.set("before", cursor);
  return `?${params}`;
}

function renderPageState(prefix, page) {
  const loading = page.phase === "loading";
  $(`#${prefix}`).setAttribute("aria-busy", String(loading));
  $(`#${prefix}-state`).textContent = loading ? "正在读取…" : page.phase === "error" ? `历史暂不可用：${page.error} 可单独重试，已提交的问题无需重复发送。` : "";
  $(`#${prefix}-retry`).hidden = page.phase !== "error";
  $(`#${prefix}-more`).hidden = !page.has_more || page.phase === "error";
  $(`#${prefix}-more`).disabled = loading;
}

function renderSessions(page) {
  const container = $("#sessions");
  container.replaceChildren();
  if (!page.items.length && page.phase === "ready") container.innerHTML = '<p class="empty">还没有会话。发送一个问题开始分析。</p>';
  for (const session of page.items) {
    const button = document.createElement("button");
    button.className = `session ${session.session_id === state.sessionId ? "active" : ""}`;
    button.textContent = session.title;
    button.title = session.title;
    if (session.session_id === state.sessionId) button.setAttribute("aria-current", "true");
    button.addEventListener("click", () => run(() => openSession(session.session_id)));
    container.append(button);
  }
  renderPageState("sessions", page);
  updateControls();
}

function clearResult() {
  state.job = null;
  state.events = [];
  state.runningJobId = null;
  state.streamJobId = null;
  state.activity++;
  state.detailRetry = null;
  $("#detail-retry").hidden = true;
  result.replaceChildren();
  $("#log").replaceChildren();
  $("#event-count").textContent = "0";
  $("#stream-status").textContent = "";
  $("#history").innerHTML = '<p class="empty">这个会话还没有问题。</p>';
  setStatus(null);
  question.placeholder = state.placeholder;
}

function renderHistory(page) {
  const container = $("#history");
  container.replaceChildren();
  if (!page.items.length && ["ready", "idle"].includes(page.phase)) container.innerHTML = '<p class="empty">这个会话还没有问题。</p>';
  for (const job of page.items) {
    const button = document.createElement("button");
    button.className = `session history-item ${job.job_id === state.job?.job_id ? "active" : ""}`;
    button.textContent = `${labels[job.status] || job.status} · ${job.user_text_preview}`;
    button.title = job.user_text_preview;
    if (job.job_id === state.job?.job_id) button.setAttribute("aria-current", "true");
    button.addEventListener("click", () => run(() => openJob(job.job_id)));
    container.append(button);
  }
  renderPageState("history", page);
  updateControls();
}

async function openSession(sessionId) {
  stream.stop();
  const navigation = ++state.navigation;
  state.sessionId = sessionId;
  state.detailLoading = true;
  clearResult();
  historyPager.reset(sessionId);
  renderSessions(sessionsPager.state);
  updateControls();
  try {
    const session = await api(`/api/sessions/${encodeURIComponent(sessionId)}`);
    if (navigation !== state.navigation) return;
    rememberSession(sessionId);
    notice.hidden = true;
    question.value = "";
    state.runningJobId = session.active_job_id;
    const loaded = await historyPager.load();
    if (navigation !== state.navigation) return;
    const selected = state.runningJobId || (loaded ? historyPager.state.items[0]?.job_id : null);
    if (selected) await loadJob(selected, navigation);
  } catch (error) {
    if (navigation !== state.navigation) return;
    if (error.status === 404) { state.sessionId = null; rememberSession(""); }
    else {
      state.detailRetry = () => openSession(sessionId);
      $("#detail-retry").hidden = false;
    }
    throw error;
  } finally {
    if (navigation === state.navigation) state.detailLoading = false;
    updateControls();
  }
}

async function loadJob(jobId, navigation) {
  try {
    const job = await api(`/api/jobs/${encodeURIComponent(jobId)}`);
    if (navigation !== state.navigation) return;
    state.detailRetry = null;
    $("#detail-retry").hidden = true;
    notice.hidden = true;
    showJob(job);
    renderHistory(historyPager.state);
    if (job.status === "queued" || job.status === "running") listen(job);
  } catch (error) {
    if (navigation !== state.navigation) return;
    state.detailRetry = () => openJob(jobId);
    $("#detail-retry").hidden = false;
    throw error;
  }
}

async function openJob(jobId) {
  const navigation = ++state.navigation;
  state.detailLoading = true;
  updateControls();
  try { await loadJob(jobId, navigation); }
  finally {
    if (navigation === state.navigation) state.detailLoading = false;
    updateControls();
  }
}

function jobSummary(job) {
  return { job_id: job.job_id, session_id: job.session_id, status: job.status, user_text_preview: job.user_text.slice(0, 240), created_at: job.created_at };
}

async function createSession() {
  const identity = state.visitorId;
  let creationKey = "";
  try {
    const pending = JSON.parse(sessionStorage.getItem("vv-pending-session") || "null");
    if (pending?.identity === identity && typeof pending.key === "string") creationKey = pending.key;
  } catch { /* ignore malformed local state */ }
  if (!creationKey) creationKey = crypto.randomUUID();
  try { sessionStorage.setItem("vv-pending-session", JSON.stringify({identity,key:creationKey})); }
  catch { if (state.controlledIdentity) throw new Error("无法保存会话创建标识，请启用浏览器会话存储后重试。"); }
  const session = await api("/api/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({creation_key:creationKey}),
  });
  try { sessionStorage.removeItem("vv-pending-session"); } catch { /* optional in local mock */ }
  stream.stop();
  ++state.navigation;
  state.detailLoading = false;
  state.sessionId = session.session_id;
  rememberSession(session.session_id);
  clearResult();
  historyPager.reset(session.session_id);
  sessionsPager.upsert(session);
  question.value = "";
  notice.hidden = true;
  void sessionsPager.load({ refresh: true });
}

function renderEvents() {
  $("#log").replaceChildren();
  for (const event of state.events) {
    const item = document.createElement("div");
    item.className = "event";
    item.textContent = `${event.seq}. ${event.type}${event.payload?.tool_name ? ` · ${event.payload.tool_name}` : ""}${event.payload?.message ? ` · ${event.payload.message}` : ""}`;
    $("#log").append(item);
  }
  $("#event-count").textContent = String(state.events.length);
}

function showJob(job) {
  state.job = job;
  state.events = job.events || [];
  if (job.status === "queued" || job.status === "running") state.runningJobId = job.job_id;
  else if (state.runningJobId === job.job_id) state.runningJobId = null;
  setStatus(job.status);
  renderEvents();
  result.innerHTML = renderJob(job);
  question.placeholder =
    job.status === "needs_clarification"
      ? "补充口径、日期或其他条件，继续当前会话…"
      : "继续追问，或输入一个新问题…";
  $("#retry")?.addEventListener("click", () => run(() => ask(job.user_text)));
  attachPagination();
  updateControls();
}

function listen(job) {
  if (state.streamJobId === job.job_id) return;
  state.streamJobId = job.job_id;
  let cursor = 0;
  for (const event of job.events || []) {
    if (event.seq === cursor + 1) cursor = event.seq;
    else break;
  }
  stream.start(job.job_id, cursor);
}

function attachPagination() {
  for (const button of result.querySelectorAll(".resource-next, .calculation-next")) {
    button.addEventListener("click", () =>
      run(async () => {
        button.disabled = true;
        const navigation = state.navigation;
        const jobId = state.job.job_id;
        try {
          const params = new URLSearchParams({
            offset: button.dataset.offset,
            limit: "50",
            resource_hash: button.dataset.hash,
          });
          const page = await api(
            `/api/sessions/${encodeURIComponent(state.sessionId)}/resources/${encodeURIComponent(button.dataset.resource)}?${params}`,
          );
          if (navigation !== state.navigation || state.job?.job_id !== jobId || !button.isConnected) return;
          const container = button.closest(".source");
          const table = container.querySelector("table");
          let rows;
          if (container.dataset.kind === "alignment")
            rows = page.resource.rows
              .map((row) => alignmentRowHtml(row, container.dataset.coverageIncomplete === "true"))
              .join("");
          else {
            const columns =
              container.dataset.kind === "transform"
                ? page.resource.result.columns.map((column) => column.name)
                : [...table.querySelectorAll("thead th")].map((item) => item.textContent);
            const values =
              container.dataset.kind === "transform" ? page.resource.result.rows : page.resource.rows;
            rows = values
              .map(
                (row) =>
                  `<tr>${columns.map((key) => `<td>${escapeHtml(displayCell(row[key]))}</td>`).join("")}</tr>`,
              )
              .join("");
          }
          table.querySelector("tbody").insertAdjacentHTML("beforeend", rows);
          updatePaginationCount(table, button);
          if (page.has_more) button.dataset.offset = String(page.next_row_offset);
          else button.textContent = "已显示全部保存行";
          button.disabled = !page.has_more;
        } catch (error) {
          if (navigation !== state.navigation || state.job?.job_id !== jobId || !button.isConnected) return;
          button.disabled = false;
          throw error;
        }
      }),
    );
  }
}

async function ask(text) {
  text = text.trim();
  if (!text) {
    notice.hidden = false;
    notice.textContent = "请先输入一个问题。";
    question.focus();
    return;
  }
  if (!state.ready || state.busy || state.detailLoading || state.runningJobId) return;
  if (state.pendingSubmission) { notice.hidden = false; notice.textContent = "请先核对上次待确认的提交，或明确开始新分析。"; return; }
  state.busy = true;
  updateControls();
  notice.hidden = true;
  stream.stop();
  try {
    if (!state.sessionId) await createSession();
    const pending = {identity:state.visitorId,sessionId:state.sessionId,body:{
      text, idempotency_key:crypto.randomUUID(), model_id:$("#model").value, reasoning:$("#reasoning").value,
    }};
    try { sessionStorage.setItem("vv-pending-submission", JSON.stringify(pending)); }
    catch { if (state.controlledIdentity) throw new Error("无法保存提交标识，请启用浏览器会话存储后重试。"); }
    state.pendingSubmission = pending;
    await sendPending();
  } finally {
    state.busy = false;
    updateControls();
  }
}

function clearPending() {
  state.pendingSubmission = null;
  $("#pending-submission").hidden = true;
  try { sessionStorage.removeItem("vv-pending-submission"); } catch { /* optional in local mock */ }
}

async function sendPending() {
  const pending = state.pendingSubmission;
  if (!pending || pending.identity !== state.visitorId) throw new Error("待确认提交与当前访客不匹配。");
  const navigation = state.navigation;
  try {
    const job = await api(`/api/sessions/${encodeURIComponent(pending.sessionId)}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(pending.body),
    });
    clearPending();
    if (navigation !== state.navigation) { void sessionsPager.load({ refresh: true }); return; }
    if (state.sessionId !== pending.sessionId) {
      stream.stop(); state.streamJobId = null; ++state.navigation; state.runningJobId = null;
      state.sessionId = pending.sessionId; rememberSession(pending.sessionId); historyPager.reset(pending.sessionId);
    }
    question.value = "";
    state.activity++;
    showJob(job);
    historyPager.upsert(jobSummary(job));
    if (job.status === "queued" || job.status === "running") listen(job);
    void sessionsPager.load({ refresh: true });
  } catch (error) {
    const clearlyRejected = [400,403,404,409,413,415,429].includes(error?.status) || ["analysis_not_ready", "global_active_limit"].includes(error?.code);
    if (clearlyRejected) clearPending();
    else $("#pending-submission").hidden = false;
    throw error;
  }
}

$("#composer").addEventListener("submit", (event) => {
  event.preventDefault();
  void run(() => ask(question.value));
});
question.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key === "Enter" && !event.isComposing) {
    event.preventDefault();
    void run(() => ask(question.value));
  }
});
$("#new-session").addEventListener("click", () =>
  run(async () => {
    if (state.busy) return;
    state.busy = true;
    updateControls();
    try {
      await createSession();
      question.focus();
    } finally {
      state.busy = false;
    }
  }),
);
$("#cancel").addEventListener("click", () =>
  run(async () => {
    if (!state.runningJobId || state.busy) return;
    const navigation = state.navigation;
    state.busy = true;
    updateControls();
    try {
      const job = await api(`/api/jobs/${encodeURIComponent(state.runningJobId)}/cancel`, { method: "POST" });
      if (navigation !== state.navigation) return;
      showJob(job);
      // Cancellation can still be pending; the terminal event remains authoritative.
      if (job.status === "queued" || job.status === "running") listen(job);
    } finally {
      state.busy = false;
    }
  }),
);
$("#history-toggle").addEventListener("click", () => {
  const button = $("#history-toggle");
  const expanded = button.getAttribute("aria-expanded") !== "true";
  button.setAttribute("aria-expanded", String(expanded));
  $("#sidebar").classList.toggle("expanded", expanded);
});
$("#sessions-more").addEventListener("click", () => void sessionsPager.load());
$("#sessions-retry").addEventListener("click", () => void sessionsPager.load());
$("#history-more").addEventListener("click", () => void historyPager.load());
$("#history-retry").addEventListener("click", () => run(async () => {
  const navigation = state.navigation;
  if (await historyPager.load() && navigation === state.navigation && !state.job) {
    const selected = state.runningJobId || historyPager.state.items[0]?.job_id;
    if (selected) await openJob(selected);
  }
}));
$("#active-job").addEventListener("click", () => run(() => openJob(state.runningJobId)));
$("#detail-retry").addEventListener("click", () => run(() => state.detailRetry?.()));
window.addEventListener("pagehide", () => stream.stop());
$("#pending-resume").addEventListener("click", () => run(async () => {
  if (state.busy || !state.ready) return;
  state.busy = true; updateControls();
  try { await sendPending(); } finally { state.busy = false; updateControls(); }
}));
$("#pending-new").addEventListener("click", () => { clearPending(); notice.hidden = false; notice.textContent = "已放弃核对旧提交；它仍可能在后台完成。可以明确开始新的分析。"; });
$("#visitor-reset").addEventListener("click", () => run(async () => {
  await api("/api/visitor/reset", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  try { sessionStorage.removeItem("lumenfox-session"); } catch { /* no stored selection */ }
  try { sessionStorage.removeItem("vv-pending-submission"); sessionStorage.removeItem("vv-pending-session"); } catch { /* no stored state */ }
  location.reload();
}));

async function initialize() {
  const [demo, health] = await Promise.all([
    api("/api/demo"),
    api("/api/health"),
  ]);
  if (health.identity === "controlled-visitor-experimental") {
    state.controlledIdentity = true;
    const visitor = await api("/api/visitor", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    state.visitorCsrf = visitor.csrf_token;
    state.visitorId = visitor.visitor_id;
  }
  try {
    const pending = JSON.parse(sessionStorage.getItem("vv-pending-submission") || "null");
    if (pending?.identity === state.visitorId && pending.sessionId && pending.body?.idempotency_key) { state.pendingSubmission = pending; $("#pending-submission").hidden = false; }
  } catch { /* malformed state is never submitted */ }
  document.title = demo.title ?? `${demo.scenario} 数据分析`;
  $("#scenario-title").textContent = demo.title ?? `${demo.scenario} 数据分析`;
  if (demo.scenario === "VV Data Agent") {
    $("#brand-mark").textContent = "VV";
    $("#release-context").hidden = false;
    $("#release-description").textContent = releaseDescription(demo);
    $("#release-version").textContent = demo.release?.dataset_version || "未绑定发布";
    $("#workspace-intro").textContent = "探索拼格、落块、叠叠乐，从获客到长期回收。";
  }
  state.placeholder = demo.placeholder;
  question.placeholder = state.placeholder;
  $("#database-label").textContent =
    health.business_engine === "clickhouse" ? "ClickHouse · 合成数据" : "SQLite · 合成数据";
  const descriptions = {
    deterministic: "确定性演示：只理解登记过的产品、地区、平台、渠道和指标，不是通用模型。",
    faux: "Pi 本地伪模型：用于验证工具和会话流程，不调用外部模型。",
    script: "Pi 本机脚本模型：用于协议演示，不代表真实模型的自主分析能力。",
    deepseek: "Pi 已配置 DeepSeek：问题、授权知识和工具结果会发送给供应商。仅用于合成数据验证。",
    local: "Pi 使用用户配置的本机 OpenAI 兼容服务，模型能力尚未认证。",
  };
  const mode =
    health.model_mode === "deterministic"
      ? "deterministic"
      : health.model_provider === "faux"
        ? "faux"
        : health.protocol_scripted
          ? "script"
          : health.model_provider === "deepseek"
            ? "deepseek"
            : "local";
  $("#banner").textContent =
    mode === "deepseek"
      ? "DeepSeek · 合成数据验证"
      : mode === "local"
        ? "本机模型 · 能力待验证"
        : "本地演示 · 非通用模型";
  $("#mode-description").textContent = descriptions[mode];
  state.models = health.model_catalog?.models || [];
  $("#model").replaceChildren();
  for (const model of state.models) {
    const option = document.createElement("option");
    option.value = model.id;
    option.textContent = model.id;
    $("#model").append(option);
  }
  const fillReasoning = () => {
    $("#reasoning").replaceChildren();
    const model = state.models.find((item) => item.id === $("#model").value);
    for (const level of model?.reasoning || ["off"]) {
      const option = document.createElement("option");
      option.value = level;
      option.textContent = level;
      $("#reasoning").append(option);
    }
  };
  $("#model").addEventListener("change", fillReasoning);
  fillReasoning();
  mountExamples(document, demo, (item) => {
    question.value = item.text;
    question.focus();
  });
  state.ready = state.models.length > 0;
  if (!state.ready) throw new Error("服务端没有可用模型，请检查本机配置。");
  updateControls();
  const navigation = state.navigation;
  const loaded = await sessionsPager.load();
  if (navigation !== state.navigation) return;
  let saved;
  try {
    saved = sessionStorage.getItem("lumenfox-session");
  } catch {
    /* History remains available from the server. */
  }
  // The saved session may be outside the first page; its metadata endpoint
  // performs the ownership check independently of this history request.
  const selected = saved || (loaded ? sessionsPager.state.items[0]?.session_id : null);
  if (selected) await openSession(selected);
  updateControls();
}
void run(initialize);
