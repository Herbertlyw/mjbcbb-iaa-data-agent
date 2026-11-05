import test from "node:test";
import assert from "node:assert/strict";
import { unresolvedCandidateFailures } from "../src/candidate-failures.js";

const event = (tool: string, error: boolean, code: string | null, resource: string | null) => ({ type: "tool_finished", payload: { tool_name: tool, is_error: error, code, resource_id: resource } });

test("只有最终依赖中的后续成功可消除一个可恢复工具错误", () => {
  const syntax = event("query", true, "unparseable_sql", null);
  const success = event("query", false, null, "res_selected");
  assert.equal(unresolvedCandidateFailures([syntax, success], new Set(["res_selected"])), 0);
  assert.equal(unresolvedCandidateFailures([syntax, success], new Set(["res_other"])), 1);
  assert.equal(unresolvedCandidateFailures([success, syntax], new Set(["res_selected"])), 1);
  assert.equal(unresolvedCandidateFailures([syntax, syntax, success], new Set(["res_selected"])), 1);
  assert.equal(unresolvedCandidateFailures([event("query", true, "table_not_authorized", null), success], new Set(["res_selected"])), 1);
  assert.equal(unresolvedCandidateFailures([syntax, event("calculate_session_cells", false, null, "res_selected")], new Set(["res_selected"])), 1);
});
