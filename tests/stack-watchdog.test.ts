import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { randomUUID } from "node:crypto";

test("隔离栈正常收尾后守护进程退出；异常断开仍只清理本轮容器", async () => {
  const tools = mkdtempSync(path.join(tmpdir(), "watchdog-test-tools-"));
  const marker = path.join(tools, "calls");
  const id = randomUUID();
  const docker = path.join(tools, "docker");
  writeFileSync(docker, '#!/bin/sh\nprintf "%s\\n" "$*" >> "$MARKER"\nif [ "$1" = inspect ]; then printf "%s\\n" "$OWN_ID"; fi\n');
  chmodSync(docker, 0o700);
  async function run(completion: string | null, label = id): Promise<string> {
    const dir = mkdtempSync(path.join(tmpdir(), "dataagent-stack-"));
    const child = spawn(process.execPath, ["scripts/stack-watchdog.mjs", id, dir], { env: { PATH: tools, TMPDIR: tmpdir(), MARKER: marker, OWN_ID: label }, stdio: ["pipe", "ignore", "pipe"] });
    let stderr = ""; child.stderr.on("data", chunk => { stderr += String(chunk); });
    const exit = new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
    child.stdin.end(completion ?? undefined);
    assert.equal(await exit, 0, stderr);
    return dir;
  }
  try {
    const normal = await run("cleanup-complete\n");
    assert.equal(existsSync(marker), false, "正常收尾不得启动竞争的 Docker 清理");
    assert.equal(existsSync(normal), true);
    rmSync(normal, { recursive: true, force: true });
    const abandoned = await run(null);
    assert.equal(existsSync(abandoned), false);
    const lines = readFileSync(marker, "utf8").trim().split("\n");
    assert.equal(lines.length, 6);
    for (const line of lines) assert.ok(line.includes(id), line);
    assert.equal(lines.filter(line => line.startsWith("rm -f ")).length, 3);
    writeFileSync(marker, "");
    const unowned = await run(null, randomUUID());
    assert.equal(existsSync(unowned), false);
    const checked = readFileSync(marker, "utf8").trim().split("\n");
    assert.equal(checked.length, 3);
    assert.ok(checked.every(line => line.startsWith("inspect ")), "不删除标签不匹配的容器");
  } finally { rmSync(tools, { recursive: true, force: true }); }
});
