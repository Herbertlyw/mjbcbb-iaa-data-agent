import assert from "node:assert/strict";
import test from "node:test";
import {
  prepareJoinEvidence,
  verifyJoinEvidence,
  type JoinEvidencePlan,
} from "../src/join-evidence.js";
import { joinCoverage } from "../src/join-resource-proof.js";
import { joinResultTable } from "../src/join-result-table.js";
import { loadKnowledge } from "../src/knowledge.js";
import { REAL_F_JOIN_SQL } from "./real-model-f-sql.js";

const knowledge = loadKnowledge("knowledge/harborlight");
const fact = knowledge.contract_by_table.get(
  "fact_fox_daily_install",
)!.contract!;
const dim = knowledge.contract_by_table.get("dim_fox_title")!.contract!;

function captured(
  plan: JoinEvidencePlan,
  values: Array<number | null>,
  counts: Record<string, unknown>,
) {
  const fields: Record<string, string> = {
    "fact.title_id": "paper_lantern",
    "fact.platform": "ios",
    "fact.country_code": "JP",
    "fact.channel_id": "mist_ads",
    "dimension.title_id": "paper_lantern",
    "dimension.title_name": "纸灯",
  };
  const columns = [
    ...new Set(
      plan.metrics
        .filter((metric) => metric.operation !== "count_rows")
        .map((metric) => metric.column),
    ),
  ];
  return {
    title_name: "纸灯",
    ...counts,
    __da_join_proof: plan.expectedDates.map((date, index) => [
      date,
      ...columns.map(() => values[index]),
      ...plan.proofFields.map(
        (field) => fields[`${field.table}.${field.column}`],
      ),
    ]),
  };
}

test("真实 F JOIN 同时核验零、NULL、总记录行数和新增合计", () => {
  const plan = prepareJoinEvidence(
    REAL_F_JOIN_SQL,
    fact,
    dim,
    knowledge.joins,
    true,
  );
  assert.ok(plan, "实际 F SQL 应能形成独立证明计划，不以替换 COUNT 语义绕过");
  const row = captured(plan, Array(7).fill(10), {
    null_rows: "0",
    zero_rows: "0",
    row_count: "7",
    new_users_sum: "70",
  });
  const checked = verifyJoinEvidence(plan, [row]);
  assert.ok(checked);
  assert.deepEqual(
    checked.map((value) => [value.operation, value.value]),
    [
      ["count_null", "0"],
      ["count_zero", "0"],
      ["count_rows", "7"],
      ["sum", "70"],
    ],
  );
  const table = joinResultTable(plan, checked, fact, dim);
  assert.equal(table?.rows[0]?.new_users_sum, "70");
  assert.equal(
    table?.columns.find((column) => column.name === "new_users_sum")?.unit,
    "人",
  );
  assert.equal(
    table?.columns.find((column) => column.name === "row_count")?.unit,
    "行",
  );
  assert.match(
    table!.columns.find((column) => column.name === "row_count")!.label,
    /观测行数/u,
  );
  for (const invalid of [
    { ...row, zero_rows: "1" },
    { ...row, null_rows: "1" },
    { ...row, row_count: "6" },
    { ...row, new_users_sum: "71" },
    { ...row, __da_join_proof: row.__da_join_proof.slice(1) },
    {
      ...row,
      __da_join_proof: [...row.__da_join_proof, row.__da_join_proof[0]!],
    },
  ])
    assert.equal(verifyJoinEvidence(plan, [invalid]), null);
  const zeroRow = captured(plan, [10, 0, 12, 0, 14, 15, 16], {
    null_rows: "0",
    zero_rows: "2",
    row_count: "7",
    new_users_sum: "67",
  });
  assert.ok(verifyJoinEvidence(plan, [zeroRow]));
  const missing = captured(plan, [10, 0, null, 10, 10, 10, 10], {
    null_rows: "1",
    zero_rows: "1",
    row_count: "7",
    new_users_sum: "50",
  });
  assert.equal(
    verifyJoinEvidence(plan, [missing]),
    null,
    "NULL 指标不能因 SQL SUM 忽略 NULL 而被认证为完整合计",
  );
  assert.equal(
    joinResultTable(
      plan,
      checked.map((value) =>
        value.operation === "count_rows" ? { ...value, unit: "人" } : value,
      ),
      fact,
      dim,
    ),
    null,
    "记录行数不能冒充人数",
  );
});

test("COUNT 和字段计数在 NULL 输入下保持不同语义", () => {
  const sql = REAL_F_JOIN_SQL.replace(
    "SUM(f.new_users) AS new_users_sum",
    "COUNT(f.new_users) AS non_null_rows",
  );
  const plan = prepareJoinEvidence(sql, fact, dim, knowledge.joins, true);
  assert.ok(plan);
  const row = captured(plan, [10, 0, null, 10, 10, 10, 10], {
    null_rows: "1",
    zero_rows: "1",
    row_count: "7",
    non_null_rows: "6",
  });
  const checked = verifyJoinEvidence(plan, [row]);
  assert.ok(checked);
  assert.deepEqual(
    checked.map((value) => [value.operation, value.value]),
    [
      ["count_null", "1"],
      ["count_zero", "1"],
      ["count_rows", "7"],
      ["count_nonnull", "6"],
    ],
  );
  assert.equal(verifyJoinEvidence(plan, [{ ...row, row_count: "6" }]), null);
  assert.deepEqual(joinCoverage(plan, [row], fact).null_dates, ["2026-10-08"]);
  const star = prepareJoinEvidence(
    sql.replace("count()", "COUNT(*)"),
    fact,
    dim,
    knowledge.joins,
    true,
  );
  assert.ok(star);
  assert.ok(verifyJoinEvidence(star, [row]));
});

test("仅计记录行数不读取伪造指标；未支持谓词及重复键仍拒绝", () => {
  const sql = REAL_F_JOIN_SQL.replace(
    /countIf\(f.new_users IS NULL\) AS null_rows,[\s\S]*?SUM\(f.new_users\) AS new_users_sum/u,
    "COUNT(*) AS row_count",
  );
  const plan = prepareJoinEvidence(sql, fact, dim, knowledge.joins, true);
  assert.ok(plan);
  const row = captured(plan, [], { row_count: "7" });
  assert.ok(verifyJoinEvidence(plan, [row]));
  assert.deepEqual(joinCoverage(plan, [row], fact).zero_dates, []);
  assert.equal(
    prepareJoinEvidence(
      REAL_F_JOIN_SQL.replace("f.new_users = 0", "f.new_users = 0 OR 1 = 1"),
      fact,
      dim,
      knowledge.joins,
      true,
    ),
    null,
  );
  assert.equal(
    prepareJoinEvidence(
      REAL_F_JOIN_SQL.replace(
        "f.title_id = t.title_id",
        "f.country_code = t.title_id",
      ),
      fact,
      dim,
      knowledge.joins,
      true,
    ),
    null,
  );
});
