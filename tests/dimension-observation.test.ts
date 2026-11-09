import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import test from "node:test";
import type { ClickHouseClient } from "@clickhouse/client";
import { verifyDimensionObservations } from "../src/dimension-observation.js";
import { probeClickHouseAndPublish } from "../src/freshness.js";
import { loadKnowledge } from "../src/knowledge.js";
import { ToolService } from "../src/tools.js";
import type { AnalysisRecord, QueryResource } from "../src/types.js";
import { analyst, withRuntime } from "./helpers.js";

const knowledge = loadKnowledge("knowledge/harborlight");
const contract = knowledge.contract_by_table.get("dim_fox_title")!.contract!;
const sql = "SELECT title_id, title_name FROM dim_fox_title ORDER BY title_id";
const records = [
  {
    title_id: "paper_lantern",
    title_name: "纸灯",
    genre: "puzzle",
    launched_on: "2026-01-01",
  },
  {
    title_id: "glass_minnow",
    title_name: "玻璃鲦",
    genre: "casual",
    launched_on: "2026-02-01",
  },
];

// Real publication hashing and application tools; the database transport is a
// fixed local fixture, not an execution test of the SQL on ClickHouse.
async function scenario(
  run: (input: {
    tools: ToolService;
    sessionId: string;
    source: QueryResource;
    publication: Awaited<ReturnType<typeof probeClickHouseAndPublish>>;
    save: (resource: QueryResource) => void;
    publicationPath: string;
    setLabel: (value: string) => void;
  }) => Promise<void>,
) {
  await withRuntime({}, async (runtime) => {
    const targetsPath = `${runtime.config.freshnessPath}.targets.json`;
    writeFileSync(
      targetsPath,
      JSON.stringify({
        source: "synthetic-dimension-fixture",
        engine: "clickhouse-local",
        valid_until: "2027-04-01",
        targets: [
          {
            table: contract.table,
            engine: "clickhouse-local",
            kind: "dimension_snapshot",
            key_columns: contract.grain,
            snapshot_columns: contract.columns.map((column) => column.name),
          },
        ],
      }),
    );
    const publication = await probeClickHouseAndPublish({
      targetsPath,
      destinationPath: runtime.config.freshnessPath,
      query: async () =>
        records.map((row) => ({
          event_date: JSON.stringify(
            contract.columns.map(
              (column) => row[column.name as keyof typeof row],
            ),
          ),
        })),
    });
    let label = records[0]!.title_name;
    let sequence = 0;
    const client = {
      query: async ({ query }: { query: string }) => {
        if (query.startsWith("DESCRIBE TABLE"))
          return {
            json: async () =>
              contract.columns.map(({ name, type }) => ({ name, type })),
          };
        const columns = query.startsWith("EXPLAIN PLAN")
          ? ["explain"]
          : ["title_id", "title_name"];
        const types = columns.map((name) =>
          name === "explain"
            ? "String"
            : contract.columns.find((column) => column.name === name)!.type,
        );
        const rows = query.startsWith("EXPLAIN PLAN")
          ? [["Expression"]]
          : records.map((row, index) => [
              row.title_id,
              index === 0 ? label : row.title_name,
            ]);
        return {
          query_id: `dimension_fixture_${++sequence}`,
          stream: async function* () {
            yield [columns, types, ...rows].map((row) => ({ json: () => row }));
          },
          close: () => {},
        };
      },
    } as unknown as ClickHouseClient;
    const tools = new ToolService({
      config: {
        ...runtime.config,
        businessEngine: "clickhouse",
        clickhouseDatabase: "synthetic",
        freshnessTargetsPath: targetsPath,
      },
      knowledge,
      db: runtime.db,
      sessions: runtime.sessions,
      businessEngine: "clickhouse",
      clickhouse: client,
    });
    const session = analyst(runtime);
    runtime.sessions.setActiveJob(session.session_id, "job_dimension_fixture");
    assert.equal(
      (
        await tools.readDataContractView(session.session_id, {
          asset_id: contract.asset_id,
        })
      ).ok,
      true,
    );
    const result = await tools.query(session.session_id, { sql });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.time_range_kind, "contract_validity");
    const found = runtime.sessions.lookupResource(
      session.session_id,
      String(result.resource_id),
    );
    assert.ok(found.ok && found.resource.kind === "query_result");
    await run({
      tools,
      sessionId: session.session_id,
      source: found.resource,
      publication,
      publicationPath: runtime.config.freshnessPath,
      save: (resource) => runtime.sessions.saveResource(resource),
      setLabel: (value) => {
        label = value;
      },
    });
  });
}

test("维表独立读取按发布键值证明名称，不把契约有效期当作业务周期", async () => {
  await scenario(async ({ tools, sessionId, source, publication }) => {
    const checked = verifyDimensionObservations(source, contract, publication);
    assert.ok(checked.ok);
    assert.deepEqual(
      checked.observations.map((row) => [
        row.key.title_id,
        row.values.find((value) => value.column === "title_name")?.value,
      ]),
      [
        ["paper_lantern", "纸灯"],
        ["glass_minnow", "玻璃鲦"],
      ],
    );
    const result = await tools.updateAnalysis(sessionId, {
      suggested_status: "completed",
      draft_answer: "",
      resource_ids: [source.resource_id],
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    const analysis = result as unknown as AnalysisRecord;
    assert.equal(analysis.status, "completed");
    assert.equal(analysis.dimension_observations?.length, 2);
    assert.equal(analysis.sources[0]?.evidence_eligible, true);
    assert.ok(!analysis.server_reasons.includes("coverage_unknown"));
    assert.match(analysis.answer, /纸灯/);
    assert.match(analysis.answer, /仅证明所列键值/);
    assert.doesNotMatch(analysis.answer, /2026-09-01 到 2027-04-01/);
    const report = process.env.TEST_DIMENSION_REPORT_PATH;
    if (report) writeFileSync(report, JSON.stringify(analysis, null, 2));
  });
});

test("缺少完整维表主键时查询回执立即提示补齐，名称仍不可作为证据", async () => {
  await scenario(async ({ tools, sessionId }) => {
    const query = await tools.query(sessionId, { sql: "SELECT title_name FROM dim_fox_title ORDER BY title_name" });
    assert.equal(query.ok, true, JSON.stringify(query)); if (!query.ok) return;
    assert.match(String(query.notice), /不能认证为名称证据/);
    assert.match(String(query.notice), /title_id/);
    const delivered = await tools.updateAnalysis(sessionId, { suggested_status: "completed", draft_answer: "纸灯", resource_ids: [String(query.resource_id)] });
    assert.ok(delivered.ok, JSON.stringify(delivered)); if (!delivered.ok) return;
    assert.equal(delivered.status, "partial");
    assert.ok((delivered.server_reasons as string[]).includes("dimension_projection_unsupported"));
  });
});

test("维表快照匹配物理整数和可空字段，不将 NULL、零和文本混为一谈", async () => {
  await scenario(async ({ source, publicationPath }) => {
    const typed = structuredClone(contract);
    typed.columns.push({ name: "is_paid", type: "Nullable(UInt8)", description: "合成标记", nullable: true });
    const targetsPath = `${publicationPath}.typed-targets.json`;
    writeFileSync(targetsPath, JSON.stringify({ source: "synthetic-typed-dimension", engine: "clickhouse-local", valid_until: "2027-04-01", targets: [{ table: typed.table, engine: "clickhouse-local", kind: "dimension_snapshot", key_columns: typed.grain, snapshot_columns: ["title_id", "title_name", "is_paid"] }] }));
    const publication = await probeClickHouseAndPublish({ targetsPath, destinationPath: `${publicationPath}.typed.json`, query: async () => [
      { event_date: JSON.stringify(["paper_lantern", "纸灯", "0"]) },
      { event_date: JSON.stringify(["glass_minnow", "玻璃鲦", null]) },
    ] });
    const snapshot = publication.tables[typed.table]!;
    assert.ok("kind" in snapshot && snapshot.kind === "dimension_snapshot" && snapshot.snapshot_hash);
    const value = structuredClone(source);
    value.sql = value.executed_sql = "SELECT title_id, title_name, is_paid FROM dim_fox_title ORDER BY title_id";
    value.columns = ["title_id", "title_name", "is_paid"];
    value.column_types = { ...value.column_types, is_paid: "Nullable(UInt8)" };
    value.rows = [{ title_id: "paper_lantern", title_name: "纸灯", is_paid: 0 }, { title_id: "glass_minnow", title_name: "玻璃鲦", is_paid: null }];
    value.dimension_snapshot = { table: typed.table, snapshot_hash: snapshot.snapshot_hash, observed_at: snapshot.probed_at, publication_id: publication.publication_id, version: publication.version };
    value.freshness_receipts = value.freshness_receipts.map((receipt) => ({ ...receipt, publication_id: publication.publication_id, version: publication.version }));
    const checked = verifyDimensionObservations(value, typed, publication);
    assert.ok(checked.ok, JSON.stringify(checked));
    assert.equal(checked.observations[0]!.values.find((item) => item.column === "is_paid")?.value, "0");
    assert.equal(checked.observations[1]!.values.find((item) => item.column === "is_paid")?.value, null);
    for (const bad of ["NULL", 256, -1, 0.5]) {
      const changed = structuredClone(value); changed.rows[0]!.is_paid = bad;
      assert.equal(verifyDimensionObservations(changed, typed, publication).ok, false);
    }
    const wrongType = structuredClone(value); wrongType.column_types!.is_paid = "UInt8";
    assert.equal(verifyDimensionObservations(wrongType, typed, publication).ok, false);
    const missing = structuredClone(value); delete missing.rows[1]!.is_paid;
    assert.equal(verifyDimensionObservations(missing, typed, publication).ok, false);
  });
});

test("维表篡改、重复键、错误物理类型、过期发布和缺键不能变成正式名称证据", async () => {
  await scenario(
    async ({
      tools,
      sessionId,
      source,
      publication,
      save,
      publicationPath,
      setLabel,
    }) => {
      const mutations: Array<(resource: QueryResource) => void> = [
        (value) => {
          value.rows[0]!.title_name = "冒名产品";
        },
        (value) => {
          value.rows[1] = { ...value.rows[0] };
        },
        (value) => {
          value.column_types!.title_name = "UInt32";
        },
        (value) => {
          value.dimension_snapshot!.snapshot_hash = "0".repeat(64);
        },
        (value) => {
          value.dimension_snapshot!.version++;
        },
        (value) => {
          value.freshness_receipts[0]!.version++;
        },
        (value) => {
          delete value.rows[0]!.title_id;
        },
        (value) => {
          value.truncated = true;
        },
      ];
      for (const mutate of mutations) {
        const changed = structuredClone(source);
        mutate(changed);
        assert.equal(
          verifyDimensionObservations(changed, contract, publication).ok,
          false,
        );
      }
      const noKey = structuredClone(source);
      noKey.sql = noKey.executed_sql = "SELECT title_name FROM dim_fox_title";
      assert.equal(
        verifyDimensionObservations(noKey, contract, publication).ok,
        false,
      );
      const forged = structuredClone(source);
      forged.rows[0]!.title_name = "冒名产品";
      save(forged);
      const result = await tools.updateAnalysis(sessionId, {
        suggested_status: "completed",
        draft_answer: "",
        resource_ids: [source.resource_id],
      });
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.equal(
        (result as unknown as AnalysisRecord).sources[0]?.evidence_eligible,
        false,
      );
      assert.equal(
        (result as unknown as AnalysisRecord).dimension_observations,
        undefined,
      );
      assert.doesNotMatch(String(result.answer), /冒名产品/);
      save(source);
      setLabel("更新但尚未发布的名称");
      const query = await tools.query(sessionId, { sql });
      assert.equal(query.ok, false);
      assert.equal(query.code, "dimension_snapshot_mismatch");
      const newer = JSON.parse(readFileSync(publicationPath, "utf8"));
      newer.version++;
      writeFileSync(publicationPath, JSON.stringify(newer));
      const stale = await tools.updateAnalysis(sessionId, {
        suggested_status: "completed",
        draft_answer: "",
        resource_ids: [source.resource_id],
      });
      assert.equal(
        (stale as unknown as AnalysisRecord).dimension_observations,
        undefined,
      );
    },
  );
});
