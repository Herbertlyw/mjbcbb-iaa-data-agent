import test from "node:test";
import assert from "node:assert/strict";
import {
  contractProgressKey,
  partialCandidateFeedback,
  queryEquivalentKey,
  queryRetryKey,
  repeatedIdenticalToolFailure,
  safeToolResultCode,
  toolAttemptKey,
  unresolvedCandidateFailures,
} from "../src/candidate-failures.js";

const event = (
  tool: string,
  error: boolean,
  code: string | null,
  resource: string | null,
) => ({
  type: "tool_finished",
  payload: { tool_name: tool, is_error: error, code, resource_id: resource },
});

test("重复读取相同契约不是新证据；分页、版本和权限变化能恢复探索", () => {
  const receipt = { ok: true, asset_id: "contract.synthetic", content_hash: "hash-a", registry_revision: "r1", queryable: false, reason: "table_not_authorized", columns_offset: 0, columns_next_offset: null, receipt_id: "first", published_freshness: { status: "fresh", publication_id: "fp", version: 1 } };
  const key = contractProgressKey("read_data_contract_view", { details: receipt });
  assert.match(key!, /^[a-f0-9]{64}$/u);
  assert.equal(key, contractProgressKey("read_data_contract_view", { details: { ...receipt, receipt_id: "second" } }));
  assert.notEqual(key, contractProgressKey("read_data_contract_view", { details: { ...receipt, queryable: true } }));
  assert.notEqual(key, contractProgressKey("read_data_contract_view", { details: { ...receipt, content_hash: "hash-b" } }));
  assert.notEqual(key, contractProgressKey("read_data_contract_view", { details: { ...receipt, columns_offset: 1 } }));
  const attempt = toolAttemptKey("query", { sql: "SELECT synthetic" }, "authority");
  const fail = (id: string) => [
    { type: "tool_started", payload: { tool_name: "query", tool_call_id: id, attempt_key: attempt } },
    { type: "tool_finished", payload: { tool_name: "query", tool_call_id: id, is_error: true, code: "table_not_authorized" } },
  ];
  const read = (progress: string | undefined) => ({ type: "tool_finished", payload: { tool_name: "read_data_contract_view", is_error: false, progress_key: progress } });
  assert.deepEqual(repeatedIdenticalToolFailure([read(key), ...fail("a"), read(key), ...fail("b"), read(key), ...fail("c")]), { tool: "query", code: "table_not_authorized" });
  const newKey = contractProgressKey("read_data_contract_view", { details: { ...receipt, content_hash: "hash-b" } });
  assert.equal(repeatedIdenticalToolFailure([read(key), ...fail("a"), ...fail("b"), read(newKey), ...fail("c")]), null);
});

test("普通任务只在连续三次同工具同参数同错误且没有新证据时止损", () => {
  const key = toolAttemptKey("query", { sql: "SELECT synthetic", purpose: "fixture" });
  assert.match(key!, /^[a-f0-9]{64}$/u);
  assert.notEqual(key, toolAttemptKey("query", { sql: "SELECT other", purpose: "fixture" }));
  assert.equal(toolAttemptKey("query", { purpose: "fixture", sql: "SELECT synthetic" }), key);
  assert.notEqual(toolAttemptKey("query", { sql: "SELECT synthetic" }, "authority-v1"), toolAttemptKey("query", { sql: "SELECT synthetic" }, "authority-v2"));
  assert.equal(toolAttemptKey("unknown", { sql: "synthetic" }), undefined);
  const pair = (id: string, attempt = key, code = "missing_data_contract_evidence") => [
    { type: "tool_started", payload: { tool_name: "query", tool_call_id: id, attempt_key: attempt } },
    { type: "tool_finished", payload: { tool_name: "query", tool_call_id: id, code, is_error: true } },
  ];
  const repeated = [...pair("a"), ...pair("b"), ...pair("c")];
  assert.deepEqual(repeatedIdenticalToolFailure(repeated), { tool: "query", code: "missing_data_contract_evidence" });
  assert.equal(repeatedIdenticalToolFailure([...pair("a"), ...pair("b")]), null);
  assert.equal(repeatedIdenticalToolFailure([...pair("a"), ...pair("b"), ...pair("c", toolAttemptKey("query", { sql: "SELECT other" }))]), null);
  assert.equal(repeatedIdenticalToolFailure([...pair("a"), ...pair("b"), event("read_data_contract_view", false, null, null), ...pair("c")]), null);
  assert.equal(repeatedIdenticalToolFailure([...pair("a"), ...pair("b"), ...pair("c", key, "table_not_authorized")]), null);
  assert.equal(repeatedIdenticalToolFailure([...pair("a"), ...pair("b"), ...pair("c", toolAttemptKey("query", { sql: "SELECT synthetic", purpose: "fixture" }, "changed-authority"))]), null);
  assert.equal(repeatedIdenticalToolFailure([...pair("a", undefined), ...pair("b", undefined), ...pair("c", undefined)].map((entry) => entry.type === "tool_started" ? { ...entry, payload: { ...entry.payload, attempt_key: undefined } } : entry)), null);
});

test("同权限下重复的两步错误循环止损，参数变化或权限版本变化不误判", () => {
  const authority = "a".repeat(64), changed = "b".repeat(64);
  const pair = (id: string, tool: string, code: string, input: string, auth = authority) => [
    { type: "tool_started", payload: { tool_name: tool, tool_call_id: id, authority_key: auth, attempt_key: toolAttemptKey(tool, tool === "query" ? { sql: input } : { input }, auth) } },
    { type: "tool_finished", payload: { tool_name: tool, tool_call_id: id, is_error: true, code } },
  ];
  const cycle = (id: string, auth = authority) => [
    ...pair(`q${id}`, "query", "missing_data_contract_evidence", "same", auth),
    ...pair(`r${id}`, "read_data_contract_view", "asset_not_authorized", "same", auth),
  ];
  assert.deepEqual(repeatedIdenticalToolFailure([...cycle("1"), ...cycle("2"), ...cycle("3")]), { tool: "read_data_contract_view", code: "asset_not_authorized" });
  assert.equal(repeatedIdenticalToolFailure([...cycle("1"), ...cycle("2"), ...cycle("3", changed)]), null);
  assert.equal(repeatedIdenticalToolFailure([...cycle("1"), ...cycle("2"), ...pair("q3", "query", "missing_data_contract_evidence", "changed"), ...pair("r3", "read_data_contract_view", "asset_not_authorized", "same")]), null);
});

test("仅对可操作的服务端部分原因生成固定、脱敏的候选反馈", () => {
  assert.equal(partialCandidateFeedback(["coverage_unknown", "model_draft_not_verified"]), null);
  const result = partialCandidateFeedback(["arithmetic_lineage_unsupported", "model_declared_unresolved", "arithmetic_lineage_unsupported", "用户原话不能进事件"]);
  assert.deepEqual(result?.codes, ["arithmetic_lineage_unsupported", "model_declared_unresolved"]);
  assert.match(result?.message ?? "", /输入资源/u);
  assert.match(result?.message ?? "", /不要简单清空/u);
  assert.doesNotMatch(JSON.stringify(result), /用户原话不能进事件/u);
});

test("Pi 校验错误只记录固定代码，无关联证明时后续成功不能消除失败", () => {
  const result = { content: [{ type: "text", text: 'Validation failed for tool "calculate_session_cells":\nReceived arguments: PRIVATE_PLACEHOLDER' }] };
  const code = safeToolResultCode("calculate_session_cells", result, true);
  assert.equal(code, "invalid_calculation_shape");
  assert.equal(safeToolResultCode("query", result, true), null);
  assert.equal(safeToolResultCode("calculate_session_cells", result, false), null);
  assert.equal(safeToolResultCode("query", { details: { code: "not safe PRIVATE_PLACEHOLDER" } }, true), null);
  const failure = event("calculate_session_cells", true, code, null);
  const success = event("calculate_session_cells", false, null, "selected");
  assert.equal(unresolvedCandidateFailures([failure, success], new Set(["selected"])), 1);
  assert.equal(unresolvedCandidateFailures([failure, success], new Set()), 1);
});

test("缺少失败和成功关联时，即使成功资源入选也不能消除工具错误", () => {
  const syntax = event("query", true, "unparseable_sql", null);
  const success = event("query", false, null, "res_selected");
  assert.equal(
    unresolvedCandidateFailures([syntax, success], new Set(["res_selected"])),
    1,
  );
  assert.equal(
    unresolvedCandidateFailures([syntax, success], new Set(["res_other"])),
    1,
  );
  assert.equal(
    unresolvedCandidateFailures([success, syntax], new Set(["res_selected"])),
    1,
  );
  assert.equal(
    unresolvedCandidateFailures(
      [syntax, syntax, success],
      new Set(["res_selected"]),
    ),
    2,
  );
  assert.equal(
    unresolvedCandidateFailures(
      [event("query", true, "table_not_authorized", null), success],
      new Set(["res_selected"]),
    ),
    1,
  );
  assert.equal(
    unresolvedCandidateFailures(
      [syntax, event("calculate_session_cells", false, null, "res_selected")],
      new Set(["res_selected"]),
    ),
    1,
  );
});

test("仅可证明同范围同投影的等价 COUNT 写法可消解已选成功路线的一个失败", () => {
  const first = "SELECT category, COUNT(*) AS n FROM synthetic WHERE day = '2026-11-06' GROUP BY category";
  const second = "SELECT category, count() AS n FROM synthetic WHERE day = '2026-11-06' GROUP BY category";
  const key = queryEquivalentKey("query", { sql: first });
  assert.match(key!, /^[a-f0-9]{64}$/u);
  assert.equal(queryEquivalentKey("query", { sql: second }), key);
  assert.notEqual(queryEquivalentKey("query", { sql: second.replace("2026-11-06", "2026-11-05") }), key);
  assert.notEqual(queryEquivalentKey("query", { sql: second.replace("category, count()", "count()") }), key);
  assert.equal(queryEquivalentKey("query", { sql: first + " LIMIT 1" }), undefined);
  assert.equal(queryEquivalentKey("query", { sql: "SELECT (" }), undefined);
  const start = (id: string, sql: string) => ({ type: "tool_started", payload: { tool_name: "query", tool_call_id: id, retry_key: queryRetryKey("query", { sql }), equivalent_key: queryEquivalentKey("query", { sql }) } });
  const end = (id: string, error: boolean, code: string | null, resource: string | null) => ({ type: "tool_finished", payload: { tool_name: "query", tool_call_id: id, is_error: error, code, resource_id: resource } });
  const failed = [start("a", first), end("a", true, "function_not_allowed", null)];
  const good = [start("b", second), end("b", false, null, "selected")];
  assert.equal(unresolvedCandidateFailures([...failed, ...good], new Set(["selected"])), 0);
  assert.equal(unresolvedCandidateFailures([...failed, ...good], new Set()), 1);
  assert.equal(unresolvedCandidateFailures([...failed, ...failed, ...good], new Set(["selected"])), 0, "同一错误的重复事件不应永久阻挡相同有效结果");
  assert.equal(unresolvedCandidateFailures([...failed, start("c", first), end("c", true, "join_structure_unsupported", null), ...good], new Set(["selected"])), 1, "另一类失败不能被一并消除");
  assert.equal(unresolvedCandidateFailures([start("a", first), end("a", true, "table_not_authorized", null), ...good], new Set(["selected"])), 1);
  assert.equal(unresolvedCandidateFailures([...failed, start("b", second.replace("2026-11-06", "2026-11-05")), end("b", false, null, "selected")], new Set(["selected"])), 1);
});

test("补读契约后同一查询成功且进入最终依赖，才消除契约读取前置错误", () => {
  const sql =
    "SELECT event_date, amount_usd, cost_usd FROM fact_fox_daily_payment WHERE event_date = toDate('2026-10-08')";
  const key = queryRetryKey("query", { sql });
  assert.match(key!, /^[a-f0-9]{64}$/u);
  const start = (id: string, retryKey = key) => ({
    type: "tool_started",
    payload: { tool_name: "query", tool_call_id: id, retry_key: retryKey },
  });
  const end = (
    id: string,
    error: boolean,
    resource: string | null,
    code: string | null = null,
  ) => ({
    type: "tool_finished",
    payload: {
      tool_name: "query",
      tool_call_id: id,
      is_error: error,
      resource_id: resource,
      code,
    },
  });
  const failed = [
    start("first"),
    end("first", true, null, "missing_data_contract_evidence"),
  ];
  const success = [start("second"), end("second", false, "res_selected")];
  assert.equal(
    unresolvedCandidateFailures(
      [...failed, ...success],
      new Set(["res_selected"]),
    ),
    0,
  );
  assert.equal(
    unresolvedCandidateFailures(
      [...failed, ...success],
      new Set(["res_other"]),
    ),
    1,
  );
  assert.equal(
    unresolvedCandidateFailures(
      [...success, ...failed],
      new Set(["res_selected"]),
    ),
    1,
  );
  assert.equal(
    unresolvedCandidateFailures(
      [
        ...failed,
        start(
          "other",
          queryRetryKey("query", { sql: sql + " AND country_code = 'JP'" }),
        ),
        end("other", false, "res_selected"),
      ],
      new Set(["res_selected"]),
    ),
    1,
  );
  assert.equal(
    unresolvedCandidateFailures(
      [end("old", true, null, "missing_data_contract_evidence"), ...success],
      new Set(["res_selected"]),
    ),
    1,
  );
  assert.equal(
    unresolvedCandidateFailures(
      [
        start("denied"),
        end("denied", true, null, "table_not_authorized"),
        ...success,
      ],
      new Set(["res_selected"]),
    ),
    1,
  );
  assert.equal(queryRetryKey("read_asset", { sql }), undefined);
});
