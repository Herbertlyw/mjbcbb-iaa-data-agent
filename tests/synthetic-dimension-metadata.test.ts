import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { repoRoot } from "../src/config.js";
import { loadKnowledge } from "../src/knowledge.js";
import { smallWarehouse } from "../src/warehouse.js";

test("合成新增契约中的维度示例与实际数据和维表一致，且未声明封闭域", () => {
  const knowledge = loadKnowledge(path.join(repoRoot(), "knowledge", "harborlight"));
  const contract = knowledge.contract_by_table.get("fact_fox_daily_install")?.contract;
  assert.ok(contract);
  const description = (name: string) => contract.columns.find((column) => column.name === name)?.description ?? "";
  const data = smallWarehouse();
  for (const [field, values] of [["platform", ["ios", "android"]], ["country_code", ["US", "JP", "DE"]]] as const) {
    for (const value of values) {
      assert.match(description(field), new RegExp(`\\b${value}\\b`, "u"));
      assert.ok(data.installs.some((row) => row[field] === value));
    }
    assert.match(description(field), /并非封闭枚举/u);
  }
  for (const row of data.titles) { assert.ok(description("title_id").includes(row.title_id)); assert.ok(description("title_id").includes(row.title_name)); }
  for (const row of data.channels) { assert.ok(description("channel_id").includes(row.channel_id)); assert.ok(description("channel_id").includes(row.channel_name)); }
});
