import { execFile } from "node:child_process";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

// Separate process group: a terminal Ctrl+C can terminate npm and tsx before
// their finally blocks finish. EOF means the invocation owning this pipe died.
const [id, directory] = process.argv.slice(2);
if (!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/u.test(id ?? "")) process.exit(1);
const parent = path.resolve(tmpdir());
const resolved = path.resolve(directory ?? "");
if (path.dirname(resolved) !== parent || !path.basename(resolved).startsWith("dataagent-stack-")) process.exit(1);
const run = promisify(execFile);
process.stdin.resume();
let completion = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { completion = (completion + chunk).slice(0, 32); });
process.stdin.once("end", async () => {
  // The owner sends this only after it has removed its own containers and
  // files. Unexpected EOF still triggers the independent cleanup below.
  if (completion === "cleanup-complete\n") return;
  for (const service of ["redis", "mysql", "ch"]) {
    const name = `dataagent-stack-${service}-${id}`;
    try {
      const { stdout } = await run("docker", ["inspect", "--format", '{{ index .Config.Labels "dataagent.isolated" }}', name], { timeout: 10_000 });
      if (stdout.trim() === id) await run("docker", ["rm", "-f", name], { timeout: 30_000 });
    } catch { /* already removed, or not owned by this invocation */ }
  }
  await rm(resolved, { recursive: true, force: true }).catch(() => undefined);
});
