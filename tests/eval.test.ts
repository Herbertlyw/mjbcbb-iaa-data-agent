import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { diagnoseKnowledge } from "../src/knowledge-doctor.js";
import { ask, analyst, bindTables, withRuntime } from "./helpers.js";

const cases = JSON.parse(readFileSync(new URL("../eval/lumenfox-cases.json", import.meta.url), "utf8")) as {
  cases: Array<{ id: string; question: string; expect_status: string; expect_text: string[]; forbid_tool?: string }>;
};

test("知识体检只检查，不改文件", () => {
  const issues = diagnoseKnowledge();
  assert.deepEqual(issues, []);
});

test("知识体检发现契约序列、单位、时区和连接键错误", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "synthetic-knowledge-doctor-"));
  try {
    cpSync(new URL("../knowledge/harborlight", import.meta.url), dir, { recursive: true });
    const contractPath = path.join(dir, "contracts", "fact_fox_daily_install.json");
    const contract = JSON.parse(readFileSync(contractPath, "utf8"));
    contract.timezone = "Invalid/Synthetic";
    contract.valid_from = "2026-02-30";
    contract.series.date_column = "missing_date";
    const metric = contract.columns.find((column: { name: string }) => column.name === contract.series.metrics[0]);
    delete metric.unit;
    writeFileSync(contractPath, JSON.stringify(contract));
    const joinsPath = path.join(dir, "joins.json");
    const joins = JSON.parse(readFileSync(joinsPath, "utf8"));
    joins.joins[0].keys.push("missing_key");
    writeFileSync(joinsPath, JSON.stringify(joins));
    const codes = new Set(diagnoseKnowledge(dir).map((issue) => issue.code));
    for (const code of ["contract_timezone_invalid", "contract_validity_invalid", "series_contract_column_missing", "metric_unit_missing", "join_key_missing"]) assert.ok(codes.has(code), code);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("合成评测题对照手工预期，不把代理计算当金标准", async () => {
  await withRuntime({}, async (runtime) => {
    for (const item of cases.cases) {
      const session = analyst(runtime);
      const job = await ask(runtime, session.session_id, item.question, item.id);
      assert.equal(job.status, item.expect_status, item.id);
      const text = `${job.analysis?.answer ?? ""} ${job.analysis?.clarification_question ?? ""}`;
      for (const fragment of item.expect_text) assert.match(text, new RegExp(fragment), item.id);
      if (item.forbid_tool) {
        assert.equal(job.events.some((event) => event.payload.tool_name === item.forbid_tool), false, item.id);
      }
    }
  });
});

test("没有连接依据或契约哈希变化时停止查询", async () => {
  await withRuntime({}, async (runtime) => {
    const session = analyst(runtime);
    await bindTables(runtime, session.session_id, ["contract.daily_installs", "contract.player_device_map"]);
    const joined = await runtime.tools.query(session.session_id, {
      sql: "SELECT a.event_date, b.platform FROM daily_installs a JOIN player_device_map b ON a.event_date = b.event_date WHERE a.event_date >= '2026-10-06' AND a.event_date <= '2026-10-12' AND b.event_date >= '2026-10-06' AND b.event_date <= '2026-10-12'",
    });
    assert.equal(joined.ok, false);
    if (!joined.ok) assert.equal(joined.code, "missing_join_constraint");
    const asset = runtime.knowledge.by_id.get("contract.daily_installs");
    if (!asset) throw new Error("缺少契约");
    asset.content_hash = "changed-for-test";
    const stale = await runtime.tools.query(session.session_id, {
      sql: "SELECT event_date, new_users FROM daily_installs WHERE event_date >= '2026-10-06' AND event_date <= '2026-10-12'",
    });
    assert.equal(stale.ok, false);
    if (!stale.ok) assert.equal(stale.code, "asset_revision_changed");
  });
});
