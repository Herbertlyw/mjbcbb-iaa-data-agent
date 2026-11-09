import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import test from "node:test";
import type { ClickHouseClient } from "@clickhouse/client";
import { loadConfig } from "../src/config.js";
import { JobService } from "../src/jobs.js";
import { loadKnowledge } from "../src/knowledge.js";
import { ToolService } from "../src/tools.js";
import { isTerminal } from "../src/types.js";
import { analyst, withRuntime } from "./helpers.js";
import { startFakeOpenAI } from "./openai-fake-server.js";

test("Pi 重放真实 C：查询缺契约、补读后同 SQL 成功，最终差额不带历史错误", async () => {
  const token = "fictional-loopback-token";
  const fake = await startFakeOpenAI(token);
  try {
    await withRuntime({ startWorker: false }, async (runtime) => {
      const knowledge = loadKnowledge("knowledge/harborlight");
      const contract = knowledge.contract_by_table.get(
        "fact_fox_daily_payment",
      )!.contract!;
      const config = loadConfig({
        ...runtime.config,
        modelMode: "pi",
        piProvider: "openai-compatible",
        piModel: "local-protocol",
        piApiKey: token,
        piBaseUrl: fake.url,
        piContextWindow: 64000,
        piMaxOutputTokens: 512,
        protocolScript: "happy",
        knowledgeDir: "knowledge/harborlight",
        freshnessTargetsPath: "knowledge/harborlight/freshness-targets.json",
        businessEngine: "clickhouse",
        clickhouseDatabase: "synthetic",
      });
      const row: Record<string, unknown> = {
        event_date: "2026-10-08",
        title_id: "paper_lantern",
        platform: "ios",
        country_code: "US",
        channel_id: "mist_ads",
        amount_usd: "1.00",
        cost_usd: "2.00",
      };
      let sequence = 0;
      // Application execution, Pi and its HTTP protocol are real. Database
      // bytes are scripted; the remote isolated ClickHouse run remains required.
      const client = {
        query: async ({ query }: { query: string }) => {
          if (query.startsWith("DESCRIBE TABLE"))
            return {
              json: async () =>
                contract.columns.map(({ name, type }) => ({ name, type })),
            };
          const names = query.startsWith("EXPLAIN PLAN")
            ? ["explain"]
            : /^SELECT\s+([\s\S]+?)\s+FROM/iu
                .exec(query)![1]!
                .split(",")
                .map((value) => value.trim());
          const types = names.map((name) =>
            name === "explain"
              ? "String"
              : contract.columns.find((column) => column.name === name)!.type,
          );
          const values = names.map((name) =>
            name === "explain" ? "Expression" : row[name],
          );
          assert.ok(
            values.every((value) => value !== undefined),
            query,
          );
          return {
            query_id: `contract_retry_fixture_${++sequence}`,
            stream: async function* () {
              yield [names, types, values].map((value) => ({
                json: () => value,
              }));
            },
            close: () => {},
          };
        },
      } as unknown as ClickHouseClient;
      const publication = JSON.parse(
        readFileSync(config.freshnessPath, "utf8"),
      );
      publication.tables = {
        [contract.table]: { status: "fresh", as_of: "2026-10-13T00:00:00Z" },
      };
      writeFileSync(config.freshnessPath, JSON.stringify(publication));
      const tools = new ToolService({
        config,
        knowledge,
        db: runtime.db,
        sessions: runtime.sessions,
        businessEngine: "clickhouse",
        clickhouse: client,
      });
      const jobs = new JobService({
        config,
        sessions: runtime.sessions,
        tools,
        state: runtime.state,
        mysqlAsyncState: () => runtime.mysqlAsyncState(),
      });
      try {
        jobs.start();
        const session = analyst(runtime);
        const submitted = jobs.submit(
          session.session_id,
          "合成补读支付契约恢复：纸灯美国单日支付流水和支付表对应成本。",
          crypto.randomUUID(),
        );
        const deadline = Date.now() + 20000;
        let job = jobs.require(submitted.job_id);
        while (!isTerminal(job.status) && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 20));
          job = jobs.require(submitted.job_id);
        }
        assert.equal(
          job.status,
          "completed",
          JSON.stringify({
            error: job.error,
            reasons: job.analysis?.server_reasons,
            events: job.events,
          }),
        );
        assert.equal(
          job.analysis?.arithmetic_results?.[0]?.result.value,
          "-1.00",
        );
        assert.ok(
          !job.analysis?.server_reasons.includes("unresolved_tool_failure"),
        );
        const attempts = job.events.filter(
          (event) =>
            event.type === "tool_started" &&
            event.payload.tool_name === "query",
        );
        const results = job.events.filter(
          (event) =>
            event.type === "tool_finished" &&
            event.payload.tool_name === "query",
        );
        assert.equal(attempts.length, 2);
        assert.equal(
          results[0]?.payload.code,
          "missing_data_contract_evidence",
        );
        assert.equal(results[1]?.payload.is_error, false);
        assert.equal(
          attempts[0]?.payload.retry_key,
          attempts[1]?.payload.retry_key,
        );
        assert.match(String(attempts[0]?.payload.retry_key), /^[a-f0-9]{64}$/u);
        assert.ok(
          attempts.every(
            (event) => !JSON.stringify(event.payload).includes("SELECT"),
          ),
        );
        assert.equal(
          job.events.filter((event) =>
            ["job_finished", "job_failed", "job_cancelled"].includes(
              event.type,
            ),
          ).length,
          1,
        );
      } finally {
        await jobs.stop();
      }
    });
  } finally {
    await fake.close();
  }
});
