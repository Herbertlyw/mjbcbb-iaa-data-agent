import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import test from "node:test";
import type { ClickHouseClient } from "@clickhouse/client";
import { loadConfig } from "../src/config.js";
import { JobService } from "../src/jobs.js";
import { verifyDatabaseAggregates } from "../src/aggregate-evidence.js";
import { probeClickHouseAndPublish } from "../src/freshness.js";
import {
  joinMetricColumns,
  prepareJoinEvidence,
} from "../src/join-evidence.js";
import { loadKnowledge } from "../src/knowledge.js";
import { ToolService } from "../src/tools.js";
import type { Runtime } from "../src/runtime.js";
import type { AnalysisRecord, QueryResource } from "../src/types.js";
import { analyst, waitForJob, withRuntime } from "./helpers.js";
import { startFakeOpenAI } from "./openai-fake-server.js";
import { REAL_F_FACT_SQL, REAL_F_JOIN_SQL } from "./real-model-f-sql.js";

const knowledge = loadKnowledge("knowledge/harborlight");
const fact = knowledge.contract_by_table.get(
  "fact_fox_daily_install",
)!.contract!;
const dimension = knowledge.contract_by_table.get("dim_fox_title")!.contract!;

async function scenario(
  run: (input: {
    runtime: Runtime;
    tools: ToolService;
    sessionId: string;
    sources: {
      fact: QueryResource;
      dimension: QueryResource;
      joined: QueryResource;
    };
  }) => Promise<void>,
) {
  await withRuntime({ startWorker: false }, async (runtime) => {
    const targetPath = `${runtime.config.freshnessPath}.targets.json`;
    writeFileSync(
      targetPath,
      JSON.stringify({
        source: "synthetic-real-f-fixture",
        engine: "clickhouse-local",
        valid_until: "2027-04-01",
        targets: [
          {
            table: dimension.table,
            engine: "clickhouse-local",
            kind: "dimension_snapshot",
            key_columns: dimension.grain,
            snapshot_columns: dimension.columns.map((column) => column.name),
          },
        ],
      }),
    );
    const dimRow: Record<string, string> = {
      title_id: "paper_lantern",
      title_name: "纸灯",
      genre: "puzzle",
      launched_on: "2026-01-01",
    };
    const publication = await probeClickHouseAndPublish({
      targetsPath: targetPath,
      destinationPath: runtime.config.freshnessPath,
      query: async () => [
        {
          event_date: JSON.stringify(
            dimension.columns.map((column) => dimRow[column.name]),
          ),
        },
      ],
    });
    publication.tables[fact.table] = {
      status: "fresh",
      as_of: publication.published_at,
    };
    writeFileSync(runtime.config.freshnessPath, JSON.stringify(publication));
    const plan = prepareJoinEvidence(
      REAL_F_JOIN_SQL,
      fact,
      dimension,
      knowledge.joins,
      true,
    );
    assert.ok(plan);
    const metricFields = joinMetricColumns(plan);
    const fields: Record<string, string> = {
      "fact.title_id": "paper_lantern",
      "fact.platform": "ios",
      "fact.country_code": "JP",
      "fact.channel_id": "mist_ads",
      ...Object.fromEntries(
        Object.entries(dimRow).map(([key, value]) => [
          `dimension.${key}`,
          value,
        ]),
      ),
    };
    const proof = plan.expectedDates.map((date) => [
      date,
      ...metricFields.map(() => 10),
      ...plan.proofFields.map(
        (field) => fields[`${field.table}.${field.column}`],
      ),
    ]);
    const proofType = `Array(Tuple(Date,${metricFields.map((name) => fact.columns.find((column) => column.name === name)!.type).join(",")},${plan.proofFields.map((field) => (field.table === "fact" ? fact : dimension).columns.find((column) => column.name === field.column)!.type).join(",")}))`;
    let sequence = 0;
    const reply = (names: string[], types: string[], rows: unknown[][]) => ({
      query_id: `real_f_transport_${++sequence}`,
      stream: async function* () {
        yield [names, types, ...rows].map((row) => ({ json: () => row }));
      },
      close: () => {},
    });
    // The application query/proof/cell/delivery path runs normally. The wire
    // rows are scripted; actual database execution is a separate remote test.
    const client = {
      query: async ({ query }: { query: string }) => {
        if (query.startsWith("DESCRIBE TABLE")) {
          const contract = query.includes(dimension.table) ? dimension : fact;
          return {
            json: async () =>
              contract.columns.map(({ name, type }) => ({ name, type })),
          };
        }
        if (query.startsWith("EXPLAIN PLAN"))
          return reply(["explain"], ["String"], [["Expression"]]);
        if (query.includes("__da_join_proof"))
          return reply(
            [
              "title_name",
              "null_rows",
              "zero_rows",
              "row_count",
              "new_users_sum",
              "__da_join_proof",
            ],
            [
              "String",
              "UInt64",
              "UInt64",
              "UInt64",
              "Nullable(Int64)",
              proofType,
            ],
            [["纸灯", "0", "0", "7", "70", proof]],
          );
        if (query.includes(`FROM ${dimension.table}`))
          return reply(
            ["title_id", "title_name"],
            ["LowCardinality(String)", "String"],
            [["paper_lantern", "纸灯"]],
          );
        if (query.includes("GROUP BY title_id"))
          return reply(
            [
              "title_id",
              "null_rows",
              "zero_rows",
              "row_count",
              "new_users_sum",
            ],
            [
              "LowCardinality(String)",
              "UInt64",
              "UInt64",
              "UInt64",
              "Nullable(Int64)",
            ],
            [["paper_lantern", "0", "0", "7", "70"]],
          );
        const coverage =
          /^SELECT ([a-z_, ]+) FROM fact_fox_daily_install WHERE/u.exec(query);
        assert.ok(coverage, query);
        const names = coverage[1]!.split(",").map((name) => name.trim());
        const types = names.map(
          (name) => fact.columns.find((column) => column.name === name)!.type,
        );
        return reply(
          names,
          types,
          plan.expectedDates.map((date) => {
            const row: Record<string, unknown> = {
              event_date: date,
              new_users: 10,
              title_id: "paper_lantern",
              platform: "ios",
              country_code: "JP",
              channel_id: "mist_ads",
            };
            return names.map((name) => row[name]);
          }),
        );
      },
    } as unknown as ClickHouseClient;
    const tools = new ToolService({
      config: {
        ...runtime.config,
        businessEngine: "clickhouse",
        clickhouseDatabase: "synthetic",
        freshnessTargetsPath: targetPath,
      },
      knowledge,
      db: runtime.db,
      sessions: runtime.sessions,
      businessEngine: "clickhouse",
      clickhouse: client,
    });
    const session = analyst(runtime);
    runtime.sessions.setActiveJob(session.session_id, "job_actual_f_shapes");
    for (const contract of [fact, dimension])
      assert.equal(
        (
          await tools.readDataContractView(session.session_id, {
            asset_id: contract.asset_id,
          })
        ).ok,
        true,
      );
    const queries = [
      REAL_F_FACT_SQL,
      "SELECT title_id, title_name FROM dim_fox_title",
      REAL_F_JOIN_SQL,
    ];
    const resources: QueryResource[] = [];
    for (const sql of queries) {
      const result = await tools.query(session.session_id, { sql });
      assert.equal(result.ok, true, JSON.stringify(result));
      const found = runtime.sessions.lookupResource(
        session.session_id,
        String(result.resource_id),
      );
      assert.ok(found.ok && found.resource.kind === "query_result");
      resources.push(found.resource);
    }
    await run({
      runtime,
      tools,
      sessionId: session.session_id,
      sources: {
        fact: resources[0]!,
        dimension: resources[1]!,
        joined: resources[2]!,
      },
    });
  });
}

test("真实 F JOIN 与固定产品键分组在工具、计算和正式交付中保持 70 人口径", async () => {
  await scenario(async ({ tools, sessionId, sources }) => {
    const verified = verifyDatabaseAggregates(sources.fact, fact);
    assert.equal(
      verified?.find((item) => item.column === "new_users")?.value,
      "70",
    );
    assert.equal(
      verified?.find((item) => item.column === "new_users")?.unit,
      "人",
    );
    const forged = structuredClone(sources.fact);
    forged.rows[0]!.title_id = "glass_minnow";
    assert.equal(
      verifyDatabaseAggregates(forged, fact),
      null,
      "固定分组仍必须满足原始等值筛选",
    );
    for (const source of [sources.fact, sources.joined]) {
      const calc = await tools.calculateFromProtocol(sessionId, {
        operation: "cells",
        input: {
          resource_id: source.resource_id,
          execution_id: source.execution_id,
        },
        operations: [{ op: "sum", column: "new_users_sum", as: "total_users" }],
      });
      assert.equal(calc.ok, true, JSON.stringify(calc));
      const result = await tools.updateAnalysis(sessionId, {
        suggested_status: "completed",
        draft_answer: "",
        resource_ids: [String(calc.resource_id), sources.dimension.resource_id],
      });
      assert.equal(result.ok, true, JSON.stringify(result));
      const analysis = result as unknown as AnalysisRecord;
      assert.equal(
        analysis.status,
        "completed",
        JSON.stringify(analysis.server_reasons),
      );
      assert.match(analysis.answer, /70；单位 人|70（人）/u);
      assert.match(analysis.answer, /纸灯/u);
      assert.ok(
        !analysis.server_reasons.includes(
          "query_expression_semantics_unverified",
        ),
      );
      assert.ok(!analysis.server_reasons.includes("query_lineage_unsupported"));
      assert.equal(
        analysis.dimension_observations?.[0]?.key.title_id,
        "paper_lantern",
      );
      if (source === sources.joined) {
        const verified = analysis.calculations[0]?.verified_result;
        assert.deepEqual(
          verified?.rows.map((row) => ({ ...row })),
          [{ total_users: "70" }],
        );
        assert.equal(verified?.columns[0]?.unit, "人");
        assert.match(verified?.columns[0]?.label ?? "", /new_users/u);
        assert.equal(
          analysis.join_results?.[0]?.execution_id,
          source.execution_id,
        );
        assert.equal(
          analysis.join_results?.[0]?.values.find(
            (value) => value.operation === "sum",
          )?.group["dim_fox_title.title_name"],
          "纸灯",
        );
      }
      if (process.env.TEST_REAL_F_REPORT_PATH && source === sources.joined)
        writeFileSync(
          process.env.TEST_REAL_F_REPORT_PATH,
          JSON.stringify(analysis, null, 2),
        );
    }
  });
});

test("已证明的 JOIN 求和可用于工作记录，篡改与跨任务引用仍被拒绝", async () => {
  await scenario(async ({ runtime, tools, sessionId, sources }) => {
    const source = sources.joined;
    assert.ok(source.execution_id);
    const ref = { resource_id: source.resource_id, execution_id: source.execution_id, row: 0, column: "new_users_sum" };
    assert.equal((await tools.validateWorkingCells(sessionId, [ref])).ok, true);
    assert.equal((await tools.validateWorkingCells(sessionId, [{ ...ref, execution_id: "forged" }])).ok, false);
    assert.equal((await tools.validateWorkingCells(sessionId, [{ ...ref, column: "row_count" }])).ok, false);
    const declaration = { scope: "合成范围", grain: "产品", expected_group_keys: [], unresolved_questions: [], result_cells: [ref] };
    const result = await tools.updateAnalysis(sessionId, { suggested_status: "completed", draft_answer: "", resource_ids: [source.resource_id], declaration });
    assert.equal(result.ok, true, JSON.stringify(result));
    if (!result.ok) return;
    const analysis = result as unknown as AnalysisRecord;
    assert.equal(analysis.analysis_declaration?.verified_cells[0]?.value, "70");
    assert.equal(analysis.analysis_declaration?.verified_cells[0]?.unit, "人");
    assert.equal(await tools.revalidateAnalysis(sessionId, "job_actual_f_shapes", analysis), true);
    const changed = structuredClone(source);
    changed.rows[0]!.new_users_sum = "71";
    runtime.state.saveResource(changed);
    assert.equal(await tools.revalidateAnalysis(sessionId, "job_actual_f_shapes", analysis), false);
    runtime.state.saveResource(source);
    const originalFreshness = readFileSync(runtime.config.freshnessPath, "utf8");
    const later = JSON.parse(originalFreshness);
    later.publication_id = "fp_other_publication";
    writeFileSync(runtime.config.freshnessPath, JSON.stringify(later));
    assert.equal((await tools.validateWorkingCells(sessionId, [ref])).ok, false);
    assert.equal(await tools.revalidateAnalysis(sessionId, "job_actual_f_shapes", analysis), false);
    writeFileSync(runtime.config.freshnessPath, originalFreshness);
    runtime.sessions.setActiveJob(sessionId, "job_other");
    assert.equal((await tools.validateWorkingCells(sessionId, [ref])).ok, false);
  });
});

test("真实 F 的文本键 add 对齐仍拒绝；未选择维表时不擅自加入名称证据", async () => {
  await scenario(async ({ tools, sessionId, sources }) => {
    const result = await tools.calculateFromProtocol(sessionId, {
      operation: "align",
      left: {
        resource_id: sources.fact.resource_id,
        execution_id: sources.fact.execution_id,
        column: "title_id",
      },
      right: {
        resource_id: sources.dimension.resource_id,
        execution_id: sources.dimension.execution_id,
        column: "title_id",
      },
      keys: ["title_id"],
      align_op: "add",
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, "alignment_lineage_unsupported");
    assert.match(String(result.message), /数值指标|文本键/u);
    const delivered = await tools.updateAnalysis(sessionId, {
      suggested_status: "completed",
      draft_answer: "模型自称名称纸灯",
      resource_ids: [sources.fact.resource_id],
    });
    assert.equal(delivered.ok, true);
    assert.equal(
      (delivered as unknown as AnalysisRecord).dimension_observations,
      undefined,
    );
    assert.deepEqual(
      (delivered as unknown as AnalysisRecord).sources.map(
        (source) => source.resource_id,
      ),
      [sources.fact.resource_id],
    );
    assert.doesNotMatch(String(delivered.answer), /纸灯/u);
  });
});

test("本地假 HTTP 经 Pi 自然交付：真实 F JOIN 后计算及分别选入名称来源均通过", async () => {
  const token = "fictional-loopback-token";
  const fake = await startFakeOpenAI(token);
  try {
    await scenario(async ({ runtime, tools }) => {
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
          "合成真实F计数组合关联",
          "合成真实F分查并引用名称",
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
            "completed",
            JSON.stringify({
              error: job.error,
              reasons: job.analysis?.server_reasons,
              events: job.events,
            }),
          );
          assert.match(job.analysis!.answer, /70；单位 人|70（人）/u);
          assert.match(job.analysis!.answer, /纸灯/u);
          if (question.includes("计数组合关联")) {
            assert.equal(
              job.analysis!.join_results?.[0]?.values.find(
                (value) => value.operation === "sum",
              )?.value,
              "70",
            );
            assert.deepEqual(
              job.analysis!.calculations[0]?.verified_result?.rows.map(
                (row) => ({ ...row }),
              ),
              [{ total_users: "70" }],
            );
            if (process.env.TEST_REAL_F_REPORT_PATH)
              writeFileSync(
                process.env.TEST_REAL_F_REPORT_PATH,
                JSON.stringify(job.analysis, null, 2),
              );
          }
          assert.ok(
            !job.analysis!.server_reasons.includes(
              "query_expression_semantics_unverified",
            ),
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
          if (question.includes("分查"))
            assert.equal(
              job.analysis!.dimension_observations?.[0]?.values.find(
                (value) => value.column === "title_name",
              )?.value,
              "纸灯",
            );
        }
      } finally {
        await jobs.stop();
      }
    });
  } finally {
    await fake.close();
  }
});
