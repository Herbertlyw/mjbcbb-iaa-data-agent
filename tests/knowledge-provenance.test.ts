import assert from "node:assert/strict";
import { appendFileSync, cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { loadKnowledge, validateKnowledgeSources } from "../src/knowledge.js";

const root = fileURLToPath(new URL("..", import.meta.url));

async function withKnowledgeCopy(run: (directory: string) => Promise<void> | void) {
  const directory = mkdtempSync(path.join(tmpdir(), "dataagent-knowledge-test-"));
  try {
    cpSync(path.join(root, "knowledge", "lumenfox"), directory, { recursive: true });
    await run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function registry(directory: string): { assets: Array<Record<string, unknown>>; [name: string]: unknown } {
  return JSON.parse(readFileSync(path.join(directory, "registry.json"), "utf8"));
}

test("受权资产单独校验来源，未选正文变化不会成为内容探针", async () => {
  await withKnowledgeCopy(async (directory) => {
    const knowledge = loadKnowledge(directory);
    assert.equal(await validateKnowledgeSources(knowledge, ["metric.new_users", "contract.daily_installs"]), true);
    assert.equal(await validateKnowledgeSources(knowledge, ["not-in-catalog"]), false);
    // A changed unrelated asset is neither read nor exposed to this operation.
    appendFileSync(path.join(directory, "assets", "metric-ad-revenue.md"), "\nchanged\n");
    assert.equal(await validateKnowledgeSources(knowledge, ["metric.new_users"]), true);
    assert.equal(await validateKnowledgeSources(knowledge, ["metric.ad_revenue"]), false);
    appendFileSync(path.join(directory, "contracts", "daily-installs.json"), "\n");
    assert.equal(await validateKnowledgeSources(knowledge, ["contract.daily_installs"]), false);
    assert.equal(await validateKnowledgeSources(knowledge, ["metric.new_users"]), true);
  });
});

test("目录、权限、JOIN 规则变化均使旧实例的读取失败关闭", async () => {
  for (const source of ["registry.json", "policy.json", "joins.json"]) {
    await withKnowledgeCopy(async (directory) => {
      const knowledge = loadKnowledge(directory);
      assert.equal(await validateKnowledgeSources(knowledge), true);
      appendFileSync(path.join(directory, source), "\n");
      assert.equal(await validateKnowledgeSources(knowledge), false, source);
    });
  }
});

test("知识加载拒绝目录穿越、外部链接、重复资产及歧义表契约", async () => {
  await withKnowledgeCopy((directory) => {
    const manifest = registry(directory);
    manifest.assets[0]!.path = "../outside.md";
    writeFileSync(path.join(directory, "registry.json"), JSON.stringify(manifest));
    assert.throws(() => loadKnowledge(directory), /knowledge_path_invalid/);
  });
  await withKnowledgeCopy((directory) => {
    const assetPath = path.join(directory, "assets", "metric-new-users.md");
    const external = path.join(path.dirname(directory), `${path.basename(directory)}-external`);
    try {
      writeFileSync(external, "synthetic outside document");
      unlinkSync(assetPath);
      symlinkSync(external, assetPath);
      assert.throws(() => loadKnowledge(directory), /knowledge_path_outside_root/);
    } finally { rmSync(external, { force: true }); }
  });
  await withKnowledgeCopy((directory) => {
    const manifest = registry(directory);
    manifest.assets.push({ ...manifest.assets[0] });
    writeFileSync(path.join(directory, "registry.json"), JSON.stringify(manifest));
    assert.throws(() => loadKnowledge(directory), /knowledge_duplicate_or_invalid_asset_id/);
  });
  await withKnowledgeCopy((directory) => {
    const manifest = registry(directory);
    const original = manifest.assets.find((asset) => asset.asset_id === "contract.daily_installs")!;
    const contract = JSON.parse(readFileSync(path.join(directory, String(original.path)), "utf8"));
    contract.asset_id = "contract.duplicate";
    writeFileSync(path.join(directory, "contracts", "duplicate.json"), JSON.stringify(contract));
    manifest.assets.push({ ...original, asset_id: contract.asset_id, path: "contracts/duplicate.json" });
    writeFileSync(path.join(directory, "registry.json"), JSON.stringify(manifest));
    assert.throws(() => loadKnowledge(directory), /knowledge_duplicate_contract_table/);
  });
});

test("加载后更换源文件链接不能继续使用已保存身份", async () => {
  await withKnowledgeCopy(async (directory) => {
    const knowledge = loadKnowledge(directory);
    const assetPath = path.join(directory, "assets", "metric-new-users.md");
    unlinkSync(assetPath);
    symlinkSync(path.join(directory, "assets", "metric-ad-revenue.md"), assetPath);
    assert.equal(await validateKnowledgeSources(knowledge, ["metric.new_users"]), false);
    assert.equal(await validateKnowledgeSources(knowledge, ["metric.ad_revenue"]), true);
  });
});
