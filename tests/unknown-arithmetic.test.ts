import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import test from "node:test";
import type { ClickHouseClient } from "@clickhouse/client";
import { loadConfig } from "../src/config.js";
import { JobService } from "../src/jobs.js";
import { loadKnowledge } from "../src/knowledge.js";
import { verifyQueryObservation } from "../src/query-observation.js";
import { ToolService } from "../src/tools.js";
import type { AnalysisRecord, QueryResource } from "../src/types.js";
import type { Runtime } from "../src/runtime.js";
import { analyst, waitForJob, withRuntime } from "./helpers.js";
import { startFakeOpenAI } from "./openai-fake-server.js";
import { REAL_A_PAYMENT_SQL, REAL_A_SPEND_SQL } from "./real-model-a-sql.js";
import {
  groupedAResource,
  GROUPED_A_PAYMENT_SQL,
  GROUPED_A_SPEND_SQL,
} from "./grouped-a-fixture.js";

// These are the SQL shapes reported by the real-model acceptance run. This
// fixture checks protocol, authority, calculation and delivery with SQLite
// state and a fake database transport; it is not a ClickHouse execution test.
const paymentSql = `SELECT event_date, title_id, platform, country_code, channel_id,
       amount_usd, cost_usd
FROM fact_fox_daily_payment
WHERE event_date = toDate('2026-10-08')
  AND title_id = 'paper_lantern'
  AND platform = 'ios'
  AND country_code = 'US'
  AND channel_id = 'mist_ads'`;
const spendSql = `SELECT event_date, title_id, platform, country_code, channel_id,
       is_predicted, spend_usd, payback_usd
FROM fact_fox_daily_spend
WHERE event_date = toDate('2026-10-08')
  AND title_id = 'paper_lantern'
  AND platform = 'ios'
  AND country_code = 'US'
  AND channel_id = 'mist_ads'`;

async function scenario(
  run: (context: {
    runtime: Runtime;
    tools: ToolService;
    sessionId: string;
    payment: QueryResource;
    spend: QueryResource;
    save: (source: QueryResource) => void;
  }) => Promise<void>,
  queries: readonly [string, string] = [paymentSql, spendSql],
) {
  await withRuntime({ startWorker: false }, async (runtime) => {
    const knowledge = loadKnowledge("knowledge/harborlight");
    const common = {
      event_date: "2026-10-08",
      title_id: "paper_lantern",
      platform: "ios",
      country_code: "US",
      channel_id: "mist_ads",
    };
    const rows: Record<string, Record<string, unknown>> = {
      fact_fox_daily_payment: {
        ...common,
        amount_usd: "1.00",
        cost_usd: "2.00",
      },
      fact_fox_daily_spend: {
        ...common,
        is_predicted: 0,
        spend_usd: null,
        payback_usd: 1,
      },
    };
    if (queries[0] === GROUPED_A_PAYMENT_SQL)
      rows.fact_fox_daily_spend!.payback_usd = null;
    let sequence = 0;
    const client = {
      query: async ({ query }: { query: string }) => {
        const table =
          /(?:FROM|DESCRIBE TABLE)\s+(fact_fox_daily_(?:payment|spend))/iu.exec(
            query,
          )?.[1];
        const contract =
          table && knowledge.contract_by_table.get(table)?.contract;
        assert.ok(table && contract, query);
        if (query === GROUPED_A_PAYMENT_SQL || query === GROUPED_A_SPEND_SQL) {
          const source = groupedAResource(
            query === GROUPED_A_PAYMENT_SQL ? "payment" : "spend",
          );
          return {
            query_id: `synthetic_unknown_${++sequence}`,
            stream: async function* () {
              yield [
                source.columns,
                source.columns.map((name) => source.column_types![name]),
                ...source.rows.map((row) =>
                  source.columns.map((name) => row[name]),
                ),
              ].map((line) => ({ json: () => line }));
            },
            close: () => {},
          };
        }
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
              .map((name) => name.trim());
        const types = names.map((name) =>
          name === "explain"
            ? "String"
            : contract.columns.find((column) => column.name === name)!.type,
        );
        const values = names.map((name) =>
          name === "explain" ? "Expression" : rows[table]![name],
        );
        assert.ok(
          values.every((value) => value !== undefined),
          query,
        );
        return {
          query_id: `synthetic_unknown_${++sequence}`,
          stream: async function* () {
            yield [names, types, values].map((line) => ({ json: () => line }));
          },
          close: () => {},
        };
      },
    } as unknown as ClickHouseClient;
    const publication = JSON.parse(
      readFileSync(runtime.config.freshnessPath, "utf8"),
    );
    publication.tables = Object.fromEntries(
      Object.keys(rows).map((table) => [
        table,
        { status: "fresh", as_of: "2026-10-13T00:00:00Z" },
      ]),
    );
    writeFileSync(runtime.config.freshnessPath, JSON.stringify(publication));
    const tools = new ToolService({
      config: {
        ...runtime.config,
        businessEngine: "clickhouse",
        clickhouseDatabase: "synthetic",
        freshnessTargetsPath: "knowledge/harborlight/freshness-targets.json",
      },
      knowledge,
      db: runtime.db,
      sessions: runtime.sessions,
      businessEngine: "clickhouse",
      clickhouse: client,
    });
    const session = analyst(runtime);
    runtime.sessions.setActiveJob(session.session_id, "job_unknown_comparison");
    for (const table of Object.keys(rows))
      assert.equal(
        (
          await tools.readDataContractView(session.session_id, {
            asset_id: `contract.${table}`,
          })
        ).ok,
        true,
      );
    const sources: QueryResource[] = [];
    for (const sql of queries) {
      const result = await tools.query(session.session_id, { sql });
      assert.equal(result.ok, true, JSON.stringify(result));
      const saved = runtime.sessions.lookupResource(
        session.session_id,
        String(result.resource_id),
      );
      assert.ok(saved.ok && saved.resource.kind === "query_result");
      sources.push(saved.resource);
    }
    await run({
      runtime,
      tools,
      sessionId: session.session_id,
      payment: sources[0]!,
      spend: sources[1]!,
      save: (source) => runtime.sessions.saveResource(source),
    });
  });
}

test("真实调用形状的 1.00 减实际 NULL 生成可复核未知资源，并独立交付已知流水", async () => {
  await scenario(async ({ tools, sessionId, payment, spend }) => {
    const result = await tools.calculateFromProtocol(sessionId, {
      operation: "subtract",
      left: {
        resource_id: payment.resource_id,
        execution_id: payment.execution_id,
        column: "amount_usd",
        row: 0,
      },
      right: {
        resource_id: spend.resource_id,
        execution_id: spend.execution_id,
        column: "spend_usd",
        row: 0,
      },
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual((result.result as { value: unknown }).value, null);
    assert.equal(
      (result.result as { undefined_reason: unknown }).undefined_reason,
      "null_input",
    );
    const delivered = await tools.updateAnalysis(sessionId, {
      suggested_status: "completed",
      draft_answer: "",
      resource_ids: [String(result.resource_id)],
    });
    assert.equal(delivered.ok, true, JSON.stringify(delivered));
    const analysis = delivered as unknown as AnalysisRecord;
    assert.equal(analysis.status, "partial");
    assert.equal(analysis.arithmetic_results?.length, 1);
    assert.deepEqual(
      analysis.query_observations?.map((cell) => [
        cell.column,
        cell.value,
        cell.prediction,
      ]),
      [
        ["amount_usd", "1.00", "actual"],
        ["spend_usd", null, "actual"],
      ],
    );
    assert.ok(
      !analysis.server_reasons.includes("arithmetic_lineage_unsupported"),
    );
    assert.match(
      analysis.answer,
      /fact_fox_daily_payment\.amount_usd[\s\S]*1\.00/,
    );
    assert.match(analysis.answer, /fact_fox_daily_spend\.spend_usd[\s\S]*NULL/);
    assert.match(analysis.answer, /结果未知/);
    assert.doesNotMatch(
      analysis.answer,
      /-1\.00|fact_fox_daily_payment\.cost_usd/,
    );
    const path = process.env.TEST_UNKNOWN_REPORT_PATH;
    if (path) writeFileSync(path, JSON.stringify(analysis, null, 2));
  });
});

test("单日期 IN 的缺失值不会放过执行号、任务、范围、预测和截断错误", async () => {
  await scenario(
    async ({ tools, sessionId, payment, spend, save }) => {
      const calculate = (right = spend) =>
        tools.calculateFromProtocol(sessionId, {
          operation: "subtract",
          left: {
            resource_id: payment.resource_id,
            execution_id: payment.execution_id,
            column: "amount_usd",
            row: 0,
          },
          right: {
            resource_id: right.resource_id,
            execution_id: right.execution_id,
            column: "spend_usd",
            row: 0,
          },
        });
      assert.equal(
        (await calculate({ ...spend, execution_id: "wrong" })).ok,
        false,
      );
      const mutations: Array<[string, (source: QueryResource) => void]> = [
        [
          "other task",
          (source) => {
            source.job_id = "job_other";
          },
        ],
        [
          "forecast NULL",
          (source) => {
            source.rows[0]!.is_predicted = 1;
          },
        ],
        [
          "missing marker",
          (source) => {
            delete source.rows[0]!.is_predicted;
          },
        ],
        [
          "wrong physical type",
          (source) => {
            source.column_types!.spend_usd = "Nullable(String)";
          },
        ],
        [
          "truncated",
          (source) => {
            source.truncated = true;
            source.complete_population = false;
          },
        ],
        [
          "different country",
          (source) => {
            source.rows[0]!.country_code = "JP";
          },
        ],
        [
          "different date",
          (source) => {
            source.rows[0]!.event_date = "2026-10-09";
          },
        ],
        [
          "old freshness",
          (source) => {
            source.freshness_receipts[0]!.version++;
          },
        ],
        [
          "different contract",
          (source) => {
            source.contract_revisions[source.tables[0]!] = "wrong";
          },
        ],
        [
          "tampered review",
          (source) => {
            source.review_plan!.sql_hash = "wrong";
          },
        ],
      ];
      for (const [name, mutate] of mutations) {
        const invalid = structuredClone(spend);
        mutate(invalid);
        save(invalid);
        assert.equal((await calculate()).ok, false, name);
        save(spend);
      }
      const result = await calculate();
      assert.equal(result.ok, true, JSON.stringify(result));
      const changed = structuredClone(spend);
      changed.rows[0]!.spend_usd = 0;
      save(changed);
      const delivered = await tools.updateAnalysis(sessionId, {
        suggested_status: "completed",
        draft_answer: "",
        resource_ids: [String(result.resource_id)],
      });
      assert.equal(delivered.ok, true, JSON.stringify(delivered));
      assert.deepEqual(delivered.arithmetic_results, []);
      assert.ok(
        (delivered.server_reasons as string[]).includes(
          "arithmetic_lineage_unsupported",
        ),
      );
    },
    [REAL_A_PAYMENT_SQL, REAL_A_SPEND_SQL],
  );
});

test("直接观察区分实际 NULL、预测 NULL 和真实零，且不要求模型工作记录", async () => {
  await scenario(async ({ tools, sessionId, payment, spend }) => {
    const contract = loadKnowledge(
      "knowledge/harborlight",
    ).contract_by_table.get("fact_fox_daily_spend")!.contract!;
    const actual = verifyQueryObservation(spend, contract, 0, "spend_usd");
    assert.equal(actual?.value, null);
    assert.equal(actual?.prediction, "actual");
    const zero = structuredClone(spend);
    zero.rows[0]!.spend_usd = 0;
    assert.equal(
      verifyQueryObservation(zero, contract, 0, "spend_usd")?.value,
      "0",
    );
    const predicted = structuredClone(spend);
    predicted.rows[0]!.is_predicted = 1;
    assert.equal(
      verifyQueryObservation(predicted, contract, 0, "spend_usd")?.prediction,
      "predicted",
    );
    const missing = structuredClone(spend);
    delete missing.rows[0]!.spend_usd;
    assert.equal(
      verifyQueryObservation(missing, contract, 0, "spend_usd"),
      null,
    );
    const outsideScope = structuredClone(spend);
    outsideScope.rows[0]!.country_code = "JP";
    assert.equal(
      verifyQueryObservation(outsideScope, contract, 0, "spend_usd"),
      null,
    );
    const delivered = await tools.updateAnalysis(sessionId, {
      suggested_status: "partial",
      draft_answer: "",
      resource_ids: [payment.resource_id, spend.resource_id],
    });
    assert.equal(delivered.ok, true, JSON.stringify(delivered));
    const analysis = delivered as unknown as AnalysisRecord;
    assert.equal(analysis.analysis_declaration, undefined);
    assert.equal(
      analysis.query_observations?.find((cell) => cell.column === "amount_usd")
        ?.value,
      "1.00",
    );
    assert.equal(
      analysis.query_observations?.find((cell) => cell.column === "spend_usd")
        ?.value,
      null,
    );
  });
});

test("先对实际记录做全 NULL 汇总再相减仍保留未知、输入字段和递归哈希", async () => {
  await scenario(async ({ tools, sessionId, payment, spend }) => {
    const total = await tools.calculateSessionCells(sessionId, {
      resource_id: spend.resource_id,
      operations: [
        {
          op: "sum",
          column: "spend_usd",
          predicted: "actual_only",
          as: "spend",
        },
      ],
    });
    assert.equal(total.ok, true, JSON.stringify(total));
    assert.deepEqual(total.cells, { spend: null });
    const result = await tools.calculateSessionCells(sessionId, {
      arithmetic: {
        op: "subtract",
        left: {
          resource_id: payment.resource_id,
          execution_id: payment.execution_id,
          cell: "amount_usd",
          row: 0,
        },
        right: { resource_id: String(total.resource_id), cell: "spend" },
      },
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal((result.result as { value: unknown }).value, null);
    const delivered = await tools.updateAnalysis(sessionId, {
      suggested_status: "completed",
      draft_answer: "",
      resource_ids: [String(result.resource_id)],
    });
    assert.equal(delivered.ok, true, JSON.stringify(delivered));
    const analysis = delivered as unknown as AnalysisRecord;
    assert.equal(analysis.status, "partial");
    assert.equal(
      analysis.arithmetic_results?.[0]?.result.undefined_reason,
      "null_input",
    );
    assert.ok(
      !analysis.server_reasons.includes("calculation_lineage_unsupported"),
    );
    assert.deepEqual(
      analysis.query_observations?.map((cell) => [cell.column, cell.value]),
      [
        ["amount_usd", "1.00"],
        ["spend_usd", null],
      ],
    );
  });
});

test("真实 A 单日期 IN 经 Pi 自然交付已知流水与未知差额，不产生查询失败", async () => {
  const token = "fictional-loopback-token";
  const fake = await startFakeOpenAI(token);
  try {
    await scenario(
      async ({ runtime, tools }) => {
        const config = loadConfig({
          ...runtime.config,
          knowledgeDir: "knowledge/harborlight",
          modelMode: "pi",
          piProvider: "openai-compatible",
          piBaseUrl: fake.url,
          piApiKey: token,
          piModel: "local-protocol",
          piContextWindow: 64000,
          piMaxOutputTokens: 512,
          protocolScript: "happy",
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
            "合成真实A单值日期IN",
            crypto.randomUUID(),
          );
          const job = await waitForJob(runtime, submitted.job_id);
          assert.equal(
            job.status,
            "partial",
            JSON.stringify({
              error: job.error,
              reasons: job.analysis?.server_reasons,
              events: job.events,
            }),
          );
          const analysis = job.analysis!;
          assert.deepEqual(
            analysis.sources.map((source) => source.sql).sort(),
            [REAL_A_PAYMENT_SQL, REAL_A_SPEND_SQL].sort(),
          );
          assert.ok(
            analysis.sources.every(
              (source) =>
                source.executed_sql === source.sql &&
                source.evidence_eligible &&
                source.freshness_receipts.length,
            ),
          );
          assert.deepEqual(
            analysis.query_observations?.map((cell) => [
              cell.column,
              cell.value,
              cell.prediction,
            ]),
            [
              ["amount_usd", "1.00", "actual"],
              ["spend_usd", null, "actual"],
            ],
          );
          assert.equal(analysis.arithmetic_results?.[0]?.result.value, null);
          assert.equal(
            analysis.arithmetic_results?.[0]?.result.undefined_reason,
            "null_input",
          );
          assert.ok(
            !analysis.server_reasons.includes("unresolved_tool_failure"),
          );
          assert.ok(
            !analysis.server_reasons.includes("arithmetic_lineage_unsupported"),
          );
          assert.match(analysis.answer, /1\.00/u);
          assert.match(analysis.answer, /NULL/u);
          assert.doesNotMatch(
            analysis.answer,
            /-1\.00|fact_fox_daily_payment\.cost_usd/u,
          );
          assert.ok(
            !job.events.some(
              (event) =>
                event.type === "tool_finished" &&
                event.payload.is_error === true,
            ),
          );
          assert.equal(
            job.events.filter((event) =>
              [
                "job_finished",
                "job_failed",
                "job_cancelled",
                "job_timed_out",
              ].includes(event.type),
            ).length,
            1,
          );
          if (process.env.TEST_DATE_IN_REPORT_PATH)
            writeFileSync(
              process.env.TEST_DATE_IN_REPORT_PATH,
              JSON.stringify(analysis, null, 2),
            );
        } finally {
          await jobs.stop();
        }
      },
      [REAL_A_PAYMENT_SQL, REAL_A_SPEND_SQL],
    );
  } finally {
    await fake.close();
  }
});

test("真实 A 分组聚合、整批计数与混合计算引用经过 Pi 正式交付 USD 和 NULL", async () => {
  const token = "fictional-loopback-token";
  const fake = await startFakeOpenAI(token);
  try {
    await scenario(
      async ({ runtime, tools }) => {
        const config = loadConfig({
          ...runtime.config,
          knowledgeDir: "knowledge/harborlight",
          modelMode: "pi",
          piProvider: "openai-compatible",
          piBaseUrl: fake.url,
          piApiKey: token,
          piModel: "local-protocol",
          piContextWindow: 64000,
          piMaxOutputTokens: 512,
          protocolScript: "happy",
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
          for (const question of [
            "合成真实A分组聚合",
            "合成真实A聚合计算后差额",
          ]) {
            const session = analyst(runtime);
            const submitted = jobs.submit(
              session.session_id,
              question,
              crypto.randomUUID(),
            );
            const job = await waitForJob(runtime, submitted.job_id);
            assert.equal(
              job.status,
              "partial",
              JSON.stringify({
                error: job.error,
                reasons: job.analysis?.server_reasons,
                events: job.events,
              }),
            );
            const analysis = job.analysis!;
            if (process.env.TEST_GROUPED_A_REPORT_PATH)
              writeFileSync(
                process.env.TEST_GROUPED_A_REPORT_PATH,
                JSON.stringify(
                  { job, observations: fake.observations },
                  null,
                  2,
                ),
              );
            assert.deepEqual(
              analysis.query_observations?.map((item) => [
                item.column,
                item.value,
                item.unit,
                item.prediction,
              ]),
              [
                ["amount_usd", "1.00", "USD", "actual"],
                ["spend_usd", null, "USD", "actual"],
              ],
            );
            assert.equal(analysis.arithmetic_results?.[0]?.result.value, null);
            assert.equal(analysis.arithmetic_results?.[0]?.result.unit, "USD");
            assert.equal(
              analysis.arithmetic_results?.[0]?.result.undefined_reason,
              "null_input",
            );
            for (const reason of [
              "query_expression_semantics_unverified",
              "query_lineage_unsupported",
              "calculation_lineage_unsupported",
              "arithmetic_lineage_unsupported",
              "unresolved_tool_failure",
            ])
              assert.ok(
                !analysis.server_reasons.includes(reason),
                reason + JSON.stringify(analysis.server_reasons),
              );
            assert.ok(
              !job.events.some(
                (event) =>
                  event.type === "tool_finished" &&
                  event.payload.is_error === true,
              ),
            );
            assert.equal(
              job.events.filter((event) =>
                [
                  "job_finished",
                  "job_failed",
                  "job_cancelled",
                  "job_timed_out",
                ].includes(event.type),
              ).length,
              1,
            );
            assert.doesNotMatch(
              analysis.answer,
              /-1\.00|fact_fox_daily_payment\.cost_usd/u,
            );
            if (process.env.TEST_GROUPED_A_REPORT_PATH)
              writeFileSync(
                process.env.TEST_GROUPED_A_REPORT_PATH,
                JSON.stringify(analysis, null, 2),
              );
          }
        } finally {
          await jobs.stop();
        }
      },
      [GROUPED_A_PAYMENT_SQL, GROUPED_A_SPEND_SQL],
    );
  } finally {
    await fake.close();
  }
});

test("分组 NULL 差额的新增证明不能跨任务、错执行号或绕过来源哈希", async () => {
  await scenario(
    async ({ tools, sessionId, payment, spend, save }) => {
      const calculate = (execution = spend.execution_id) =>
        tools.calculateFromProtocol(sessionId, {
          operation: "subtract",
          left: {
            resource_id: payment.resource_id,
            execution_id: payment.execution_id,
            column: "amount_usd_sum",
            row: 0,
          },
          right: {
            resource_id: spend.resource_id,
            execution_id: execution,
            column: "spend_usd_sum",
            row: 0,
          },
        });
      assert.equal((await calculate("wrong")).ok, false);
      for (const [label, mutate] of [
        [
          "跨任务",
          (source: QueryResource) => {
            source.job_id = "other_job";
          },
        ],
        [
          "契约变化",
          (source: QueryResource) => {
            source.contract_revisions.fact_fox_daily_spend = "wrong";
          },
        ],
        [
          "freshness 变化",
          (source: QueryResource) => {
            source.freshness_receipts[0]!.version++;
          },
        ],
        [
          "查询计划变化",
          (source: QueryResource) => {
            source.review_plan!.sql_hash = "wrong";
          },
        ],
        [
          "非同一范围",
          (source: QueryResource) => {
            source.rows[0]!.country_code = "JP";
          },
        ],
      ] as const) {
        const changed = structuredClone(spend);
        mutate(changed);
        save(changed);
        assert.equal((await calculate()).ok, false, label);
        save(spend);
      }
      const valid = await calculate();
      assert.equal(valid.ok, true, JSON.stringify(valid));
      const changed = structuredClone(spend);
      changed.rows[0]!.spend_usd_sum = 0;
      save(changed);
      const delivery = await tools.updateAnalysis(sessionId, {
        suggested_status: "completed",
        draft_answer: "",
        resource_ids: [String(valid.resource_id)],
      });
      assert.equal(delivery.ok, true);
      assert.deepEqual(delivery.arithmetic_results, []);
      assert.ok(
        (delivery.server_reasons as string[]).includes(
          "arithmetic_lineage_unsupported",
        ),
      );
    },
    [GROUPED_A_PAYMENT_SQL, GROUPED_A_SPEND_SQL],
  );
});
