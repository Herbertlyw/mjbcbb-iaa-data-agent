import { createRuntime } from "../src/runtime.js";
import { isTerminal } from "../src/types.js";

const [stateDatabasePath, databasePath, freshnessPath, jobId] = process.argv.slice(2);
const runtime = createRuntime({
  stateDatabasePath,
  databasePath,
  freshnessPath,
  modelMode: "pi",
  piProvider: "faux",
  startWorker: true,
  ephemeralDir: undefined,
  reseedDatabase: false,
  publishFreshnessOnStart: false,
});
const started = Date.now();
while (Date.now() - started < 20_000) {
  const job = runtime.jobs.require(jobId);
  if (isTerminal(job.status)) {
    const decisions = job.events.filter((event) => event.type === "model_context").map((event) => event.payload.decision);
    const terminals = job.events.filter((event) => ["job_finished", "job_failed", "job_cancelled", "job_timed_out"].includes(event.type));
    console.log(JSON.stringify({ status: job.status, error: job.error?.code ?? null, decisions, terminals: terminals.length, user: job.user_text }));
    await runtime.close();
    process.exit(0);
  }
  await new Promise((resolve) => setTimeout(resolve, 40));
}
console.error("compaction child timed out");
await runtime.close({ abandon: true });
process.exit(2);
