import test from "node:test";
import assert from "node:assert/strict";
import {
  queryRetryKey,
  safeToolResultCode,
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

test("Pi 校验错误只记录固定代码，且仅选中依赖的后续成功可解除", () => {
  const result = { content: [{ type: "text", text: 'Validation failed for tool "calculate_session_cells":\nReceived arguments: PRIVATE_PLACEHOLDER' }] };
  const code = safeToolResultCode("calculate_session_cells", result, true);
  assert.equal(code, "invalid_calculation_shape");
  assert.equal(safeToolResultCode("query", result, true), null);
  assert.equal(safeToolResultCode("calculate_session_cells", result, false), null);
  assert.equal(safeToolResultCode("query", { details: { code: "not safe PRIVATE_PLACEHOLDER" } }, true), null);
  const failure = event("calculate_session_cells", true, code, null);
  const success = event("calculate_session_cells", false, null, "selected");
  assert.equal(unresolvedCandidateFailures([failure, success], new Set(["selected"])), 0);
  assert.equal(unresolvedCandidateFailures([failure, success], new Set()), 1);
});

test("只有最终依赖中的后续成功可消除一个可恢复工具错误", () => {
  const syntax = event("query", true, "unparseable_sql", null);
  const success = event("query", false, null, "res_selected");
  assert.equal(
    unresolvedCandidateFailures([syntax, success], new Set(["res_selected"])),
    0,
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
    1,
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
