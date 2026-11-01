import { createRuntime } from "../src/runtime.js";

const [stateDatabasePath, databasePath, freshnessPath, piBaseUrl, jobId] = process.argv.slice(2);
const runtime = createRuntime({
  stateDatabasePath,
  databasePath,
  freshnessPath,
  piBaseUrl,
  modelMode: "pi",
  piProvider: "openai-compatible",
  piModel: "local-protocol",
  piApiKey: "fictional-loopback-token",
  piContextWindow: 8000,
  piMaxOutputTokens: 512,
  piReasoning: "off",
  enabledReasoning: ["off", "low"],
  startWorker: false,
  ephemeralDir: undefined,
  reseedDatabase: false,
  publishFreshnessOnStart: false,
});
const job = runtime.jobs.require(jobId);
console.log(job.reasoning ?? "");
await runtime.close();
