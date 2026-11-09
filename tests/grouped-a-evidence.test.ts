import assert from "node:assert/strict";
import test from "node:test";
import { verifyDatabaseAggregates } from "../src/aggregate-evidence.js";
import { calculateResultCells } from "../src/result-cells.js";
import { loadKnowledge } from "../src/knowledge.js";
import { typedObservation } from "../src/typed-observation.js";
import { aggregateObservationInput } from "../src/aggregate-observation.js";
import { verifyQueryObservation } from "../src/query-observation.js";
import type { QueryResource } from "../src/types.js";
import {
  groupedAResource,
  GROUPED_A_PAYMENT_OPERATIONS,
  GROUPED_A_SPEND_OPERATIONS,
} from "./grouped-a-fixture.js";

const knowledge = loadKnowledge("knowledge/harborlight");

test("真实支付分组的四个契约维度不丢失精确金额与单位", () => {
  const source = groupedAResource("payment");
  const contract = knowledge.contract_by_table.get(
    source.tables[0]!,
  )!.contract!;
  const values = verifyDatabaseAggregates(source, contract);
  assert.equal(
    values?.find((item) => item.column === "amount_usd")?.value,
    "1.00",
  );
  assert.equal(
    values?.find((item) => item.column === "amount_usd")?.unit,
    "USD",
  );
});

test("预测标记分组的 NULL SUM 保留字段单位，actual_only 可计算整批结果", () => {
  const source = groupedAResource("spend");
  const contract = knowledge.contract_by_table.get(
    source.tables[0]!,
  )!.contract!;
  const proof = aggregateObservationInput(source, contract);
  assert.ok(proof);
  assert.equal(
    proof.table.columns.find((item) => item.name === "spend_usd_sum")?.unit,
    "USD",
  );
  assert.deepEqual(
    proof.observations.map((item) => [
      item.column,
      item.value,
      item.prediction,
    ]),
    [
      ["spend_usd", null, "actual"],
      ["payback_usd", null, "actual"],
    ],
  );
  assert.equal(proof.incomplete, true);
  const result = calculateResultCells(proof.table, GROUPED_A_SPEND_OPERATIONS);
  assert.ok(result);
  assert.deepEqual(
    { ...result.table.rows[0] },
    { spend_rows: "1", spend_null_cells: "1", spend_actual_sum: null },
  );
});

test("count_rows 冗余列名只定位已存在列，计数仍包括 NULL 行", () => {
  const input = typedObservation(groupedAResource("payment"));
  assert.ok(input);
  const result = calculateResultCells(input, GROUPED_A_PAYMENT_OPERATIONS);
  assert.ok(result, "实际整批计算不能因 count_rows 带已存在列名而失败");
  assert.equal(result.table.rows[0]!.payment_rows, "1");
  assert.equal(
    calculateResultCells(input, [
      { op: "count_rows", column: "not_in_result", as: "wrong" },
    ]),
    null,
  );
  const nullInput = {
    columns: [
      {
        name: "v",
        type: "decimal" as const,
        label: "值",
        unit: "USD",
        scale: 2,
      },
    ],
    rows: [{ v: null }],
    prediction_scope: "observed_only" as const,
  };
  assert.equal(
    calculateResultCells(nullInput, [
      { op: "count_rows", column: "v", as: "all" },
    ])?.table.rows[0]!.all,
    "1",
  );
});

test("分组证明拒绝类型、预测标记、重复分组和范围矛盾", () => {
  const contract = knowledge.contract_by_table.get(
    "fact_fox_daily_spend",
  )!.contract!;
  const cases: Array<[string, (source: QueryResource) => void]> = [
    [
      "Float 输出不能声明成 Decimal",
      (source) => {
        source.column_types!.spend_usd_sum = "Nullable(Decimal(38, 2))";
      },
    ],
    [
      "预测标记必须是已登记值",
      (source) => {
        source.rows[0]!.is_predicted = 2;
      },
    ],
    [
      "筛选外分组不能借用查询口径",
      (source) => {
        source.rows[0]!.country_code = "JP";
      },
    ],
    [
      "重复分组拒绝重复求和",
      (source) => {
        source.rows.push({ ...source.rows[0] });
        source.returned_rows = source.total_rows = 2;
      },
    ],
    [
      "返回分组不可能含零条源记录",
      (source) => {
        source.rows[0]!.rows_cnt = "0";
      },
    ],
    [
      "计数不得超过扫描上限",
      (source) => {
        source.rows[0]!.rows_cnt = String(source.scan_limit! + 1);
      },
    ],
    [
      "缺少预测标记投影",
      (source) => {
        source.sql = source.sql.replace(
          "channel_id, is_predicted,",
          "channel_id,",
        );
        source.columns = source.columns.filter(
          (name) => name !== "is_predicted",
        );
        delete source.column_types!.is_predicted;
        delete source.rows[0]!.is_predicted;
      },
    ],
    [
      "实际与预测不能被合并后再自称实际",
      (source) => {
        source.sql = source.sql.replace(
          ", channel_id, is_predicted",
          ", channel_id",
        );
      },
    ],
    [
      "NULL 覆盖不能证明数据库零是观测零",
      (source) => {
        source.rows[0]!.spend_usd_sum = 0;
      },
    ],
    [
      "截断查询不是完整结果",
      (source) => {
        source.truncated = true;
      },
    ],
    [
      "源 LIMIT 不是完整总体",
      (source) => {
        source.sql_limited = true;
      },
    ],
  ];
  for (const [label, mutate] of cases) {
    const source = groupedAResource("spend");
    mutate(source);
    assert.equal(aggregateObservationInput(source, contract), null, label);
  }
  const payment = groupedAResource("payment");
  const paymentContract = knowledge.contract_by_table.get(
    "fact_fox_daily_payment",
  )!.contract!;
  payment.rows[0]!.amount_usd_sum = 1;
  assert.equal(
    aggregateObservationInput(payment, paymentContract),
    null,
    "Decimal 字符串不能从浮点数字恢复",
  );
});

test("实际、预测 NULL 分组各自保留，实际空集和全 NULL 均不补零", () => {
  const source = groupedAResource("spend");
  const contract = knowledge.contract_by_table.get(
    source.tables[0]!,
  )!.contract!;
  source.rows.push({ ...source.rows[0], is_predicted: 1 });
  source.returned_rows = source.total_rows = 2;
  const proof = aggregateObservationInput(source, contract);
  assert.ok(proof);
  assert.deepEqual(
    proof.observations
      .filter((item) => item.column === "spend_usd")
      .map((item) => [item.value, item.prediction]),
    [
      [null, "actual"],
      [null, "predicted"],
    ],
  );
  const result = calculateResultCells(proof.table, GROUPED_A_SPEND_OPERATIONS);
  assert.deepEqual(
    { ...result?.table.rows[0] },
    { spend_rows: "2", spend_null_cells: "1", spend_actual_sum: null },
  );
  source.rows = source.rows.slice(1);
  source.returned_rows = source.total_rows = 1;
  const predicted = aggregateObservationInput(source, contract);
  assert.ok(predicted);
  assert.equal(
    calculateResultCells(predicted.table, GROUPED_A_SPEND_OPERATIONS)?.table
      .rows[0]!.spend_actual_sum,
    null,
  );
  assert.equal(
    calculateResultCells(predicted.table, GROUPED_A_SPEND_OPERATIONS)?.table
      .prediction_scope,
    undefined,
  );
});

test("COUNT 输出和结果行计数分开，业务单位不来自别名", () => {
  const source = groupedAResource("spend");
  const contract = knowledge.contract_by_table.get(
    source.tables[0]!,
  )!.contract!;
  source.rows[0]!.rows_cnt = "7";
  const proof = aggregateObservationInput(source, contract);
  assert.ok(proof);
  const result = calculateResultCells(proof.table, GROUPED_A_SPEND_OPERATIONS);
  assert.equal(
    result?.table.rows[0]!.spend_rows,
    "1",
    "一个 SQL 分组就是一个输入结果行",
  );
  assert.equal(result?.table.columns[0]!.unit, "结果行");
  assert.equal(
    proof.table.columns.find((item) => item.name === "rows_cnt")!.unit,
    "行",
  );
  assert.equal(
    verifyQueryObservation(source, contract, 0, "rows_cnt"),
    null,
    "辅助计数不能冒充成本金额",
  );
  source.sql = source.sql.replace("AS spend_usd_sum", "AS fancy_name");
  source.columns = source.columns.map((name) =>
    name === "spend_usd_sum" ? "fancy_name" : name,
  );
  source.column_types!.fancy_name = source.column_types!.spend_usd_sum!;
  delete source.column_types!.spend_usd_sum;
  source.rows[0]!.fancy_name = source.rows[0]!.spend_usd_sum;
  delete source.rows[0]!.spend_usd_sum;
  const renamed = aggregateObservationInput(source, contract);
  assert.equal(renamed?.observations[0]!.column, "spend_usd");
  assert.equal(renamed?.observations[0]!.unit, "USD");
});

test("Float 非空金额仍是近似值，NULL 证明不改变存储类型", () => {
  const source = groupedAResource("spend");
  const contract = knowledge.contract_by_table.get(
    source.tables[0]!,
  )!.contract!;
  for (const report of [source.coverage, ...(source.coverage.per_table ?? [])])
    report.null_dates = [];
  source.rows[0]!.spend_usd_sum = 2.13;
  source.rows[0]!.payback_usd_sum = 1;
  const proof = aggregateObservationInput(source, contract);
  assert.ok(proof);
  assert.equal(proof.observations[0]!.value, "2.13");
  assert.equal(proof.observations[0]!.unit, "USD");
  assert.equal(proof.observations[0]!.approximate, true);
  assert.equal(source.column_types!.spend_usd_sum, "Nullable(Float64)");
  assert.equal(
    calculateResultCells(
      proof.table,
      GROUPED_A_SPEND_OPERATIONS,
    )?.table.columns.find((column) => column.name === "spend_actual_sum")!
      .approximate,
    true,
  );
});
