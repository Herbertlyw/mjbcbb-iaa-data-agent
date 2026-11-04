import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { deepSeekKey } from "../src/deepseek-key.js";

test("仅从受限本机文件读取密钥，环境变量优先，并拒绝宽权限及链接", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "dataagent-key-test-"));
  const file = path.join(dir, "deepseek-api-key");
  try {
    assert.equal(deepSeekKey({}, dir), "");
    writeFileSync(file, "fictional-local-key", { mode: 0o600 });
    assert.equal(deepSeekKey({}, dir), "fictional-local-key");
    assert.equal(deepSeekKey({ DEEPSEEK_API_KEY: "fictional-override" }, dir), "fictional-override");
    chmodSync(file, 0o644);
    assert.throws(() => deepSeekKey({}, dir), /权限不安全/);
    rmSync(file);
    symlinkSync(path.join(dir, "absent"), file);
    assert.throws(() => deepSeekKey({}, dir), /权限不安全/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
