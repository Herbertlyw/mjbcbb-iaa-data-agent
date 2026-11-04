import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { isCalendarDate, repoRoot } from "./config.js";
import { arithmeticUnit } from "./exact-arithmetic.js";
import { loadKnowledge } from "./knowledge.js";
import { parseReadonlySql } from "./sql.js";
import type { KnowledgeBase } from "./types.js";

export interface KnowledgeIssue {
  code: string;
  message: string;
}

export function diagnoseKnowledge(root = path.join(repoRoot(), "knowledge", "lumenfox")): KnowledgeIssue[] {
  const issues: KnowledgeIssue[] = [];
  let knowledge: KnowledgeBase;
  try {
    knowledge = loadKnowledge(root);
  } catch (error) {
    return [{ code: "knowledge_load_failed", message: error instanceof Error ? error.message : "知识库无法加载" }];
  }
  const ids = knowledge.assets.map((asset) => asset.asset_id);
  if (new Set(ids).size !== ids.length) issues.push({ code: "duplicate_asset_id", message: "资产 ID 不唯一" });
  for (const asset of knowledge.assets) {
    if (!asset.revision || !asset.content_hash) issues.push({ code: "missing_revision", message: `${asset.asset_id} 缺少版本或内容哈希` });
    if (asset.contract) {
      const contract = asset.contract;
      const names = contract.columns.map((column) => column.name);
      const columns = new Set(names);
      if (columns.size !== names.length) issues.push({ code: "duplicate_contract_column", message: `${contract.table} 的字段名重复` });
      for (const column of [...contract.must_filter, ...contract.sensitive_columns, ...(contract.grain ?? [])]) {
        if (!columns.has(column)) issues.push({ code: "contract_column_missing", message: `${contract.table} 的契约引用了不存在的字段 ${column}` });
      }
      if (!isCalendarDate(contract.valid_from) || !isCalendarDate(contract.valid_until) || contract.valid_from > contract.valid_until) {
        issues.push({ code: "contract_validity_invalid", message: `${contract.table} 的契约有效期无效` });
      }
      try { new Intl.DateTimeFormat("en", { timeZone: contract.timezone }); }
      catch { issues.push({ code: "contract_timezone_invalid", message: `${contract.table} 的时区无效` }); }
      const series = contract.series;
      if (series) {
        for (const name of [series.date_column, ...series.dimensions, ...series.metrics, ...(series.predicted_column ? [series.predicted_column] : [])]) {
          if (!columns.has(name)) issues.push({ code: "series_contract_column_missing", message: `${contract.table} 的序列引用了契约中不存在的字段 ${name}` });
        }
        for (const metric of series.metrics) {
          if (!contract.columns.find((column) => column.name === metric)?.unit) issues.push({ code: "metric_unit_missing", message: `${contract.table}.${metric} 未声明单位` });
        }
      }
      for (const metric of contract.derived_metrics ?? []) {
        const resolve = (reference: string) => {
          if (typeof reference !== "string") return undefined;
          const parts = reference.split(".");
          if (parts.length > 2 || parts.some((part) => !/^[a-z_][a-z0-9_]*$/u.test(part))) return undefined;
          const source = parts.length === 1 ? contract : knowledge.contract_by_table.get(parts[0]!)?.contract;
          const column = parts.at(-1)!;
          return source?.series?.metrics.includes(column) ? source.columns.find((item) => item.name === column) : undefined;
        };
        const numerator = resolve(metric.numerator); const denominator = resolve(metric.denominator);
        const expectedUnit = numerator?.unit && denominator?.unit ? arithmeticUnit(metric.operation, numerator.unit, denominator.unit) : null;
        if (!numerator || !denominator || metric.prediction !== "actual_only" || !expectedUnit || metric.unit !== expectedUnit) issues.push({ code: "derived_metric_invalid", message: `${contract.table} 的派生指标 ${metric.id} 缺少合法来源字段或匹配单位` });
      }
    }
    if (asset.contract?.grain) {
      const names = new Set(asset.contract.columns.map((column) => column.name));
      for (const column of asset.contract.grain) {
        if (!names.has(column)) issues.push({ code: "grain_column_missing", message: `${asset.contract.table} 的粒度列 ${column} 不在契约字段里` });
      }
    }
    if (asset.status === "draft" && asset.discoverable) issues.push({ code: "draft_discoverable", message: `${asset.asset_id} 是草稿却可被检索` });
  }
  const clickhouseKnowledge = knowledge.assets.some((asset) => asset.contract?.engine === "clickhouse-local");
  const directory = mkdtempSync(path.join(tmpdir(), "lumenfox-doctor-"));
  const database = new DatabaseSync(path.join(directory, "schema.sqlite"));
  try {
    if (!clickhouseKnowledge) database.exec(knowledge.seed_sql);
    for (const asset of knowledge.assets) {
      if (!asset.contract || !/^[a-z_][a-z0-9_]*$/u.test(asset.contract.table)) continue;
      const series = asset.contract.series;
      if (series && (series.predicted_column && series.prediction_mode || !series.predicted_column && series.prediction_values)) {
        issues.push({ code: "prediction_mapping_conflict", message: `${asset.contract.table} 的预测状态声明互相冲突` });
      }
      if (series?.predicted_column) {
        const mapping = series.prediction_values;
        if (!mapping || !Number.isFinite(mapping.actual) || !Number.isFinite(mapping.predicted) || mapping.actual === mapping.predicted) {
          issues.push({ code: "prediction_mapping_missing", message: `${asset.contract.table} 的预测标记缺少明确且不同的实际/预测取值` });
        }
      }
      if (asset.contract.engine === "clickhouse-local") {
        if (asset.contract.columns.length === 0) issues.push({ code: "empty_contract", message: `${asset.contract.table} 没有字段` });
        const schemaPath = path.join(root, "schema.sql");
        if (existsSync(schemaPath)) {
          const declared = columnsInCreate(readFileSync(schemaPath, "utf8")).get(asset.contract.table);
          if (!declared) issues.push({ code: "missing_table", message: `${asset.contract.table} 不在 schema.sql` });
          else {
            for (const column of asset.contract.columns) {
              if (!declared.has(column.name)) issues.push({ code: "schema_contract_mismatch", message: `${asset.contract.table}.${column.name} 不在合成建表定义里` });
            }
          }
        }
        continue;
      }
      const columns = new Set(
        (database.prepare(`PRAGMA table_info(${asset.contract.table})`).all() as Array<{ name: string }>).map((row) => row.name),
      );
      if (columns.size === 0) {
        issues.push({ code: "missing_table", message: `${asset.contract.table} 不在合成库` });
        continue;
      }
      for (const column of asset.contract.columns) {
        if (!columns.has(column.name)) issues.push({ code: "schema_contract_mismatch", message: `${asset.contract.table}.${column.name} 没有对应字段` });
      }
      if (series) {
        for (const name of [series.date_column, ...series.dimensions, ...series.metrics, ...(series.predicted_column ? [series.predicted_column] : [])]) {
          if (!columns.has(name)) issues.push({ code: "series_column_missing", message: `${asset.contract.table} 的覆盖声明引用了不存在的字段 ${name}` });
        }
      }
    }
    const verified = JSON.parse(readFileSync(path.join(root, "verified-sql.json"), "utf8")) as {
      examples?: Array<{ example_id: string; sql: string }>;
    };
    for (const example of verified.examples ?? []) {
      try {
        const parsed = parseReadonlySql(example.sql, knowledge.assets.some((asset) => asset.contract?.engine === "clickhouse-local") ? "clickhouse" : "sqlite");
        for (const table of parsed.tables) {
          if (!knowledge.contract_by_table.has(table)) issues.push({ code: "example_sql_unknown_table", message: `${example.example_id} 使用了未登记表 ${table}` });
          if (!knowledge.policy.roles.analyst?.query_tables.includes(table)) {
            issues.push({ code: "example_sql_not_queryable", message: `${example.example_id} 的表 ${table} 不在分析师可查询范围` });
          }
        }
      } catch (error) {
        issues.push({ code: "example_sql_rejected", message: `${example.example_id}: ${error instanceof Error ? error.message : "无法解析"}` });
      }
    }
    for (const join of knowledge.joins) {
      if (join.tables.length < 2) issues.push({ code: "join_incomplete", message: `${join.join_id} 没有两张表` });
      for (const table of join.tables) {
        const contract = knowledge.contract_by_table.get(table)?.contract;
        if (!contract) issues.push({ code: "join_unknown_table", message: `${join.join_id} 指向未登记表 ${table}` });
        else for (const key of join.keys) {
          if (!contract.columns.some((column) => column.name === key)) issues.push({ code: "join_key_missing", message: `${join.join_id} 的键 ${key} 不在 ${table} 契约中` });
        }
      }
      if (!join.keys.length || new Set(join.keys).size !== join.keys.length) issues.push({ code: "join_keys_invalid", message: `${join.join_id} 的连接键为空或重复` });
    }
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
  return issues;
}

export function compareLiveColumns(root: string, live: Record<string, string[]>): KnowledgeIssue[] {
  const issues: KnowledgeIssue[] = [];
  let knowledge: KnowledgeBase;
  try {
    knowledge = loadKnowledge(root);
  } catch (error) {
    return [{ code: "knowledge_load_failed", message: error instanceof Error ? error.message : "知识库无法加载" }];
  }
  for (const asset of knowledge.assets) {
    if (asset.contract?.engine !== "clickhouse-local") continue;
    const names = new Set(live[asset.contract.table] ?? []);
    if (names.size === 0) {
      issues.push({ code: "describe_missing", message: `${asset.contract.table} 没有 DESCRIBE 结果` });
      continue;
    }
    for (const column of asset.contract.columns) {
      if (!names.has(column.name)) issues.push({ code: "describe_mismatch", message: `${asset.contract.table}.${column.name} 不在 DESCRIBE 结果里` });
    }
  }
  return issues;
}

function columnsInCreate(sql: string): Map<string, Set<string>> {
  const found = new Map<string, Set<string>>();
  for (const match of sql.matchAll(/CREATE TABLE IF NOT EXISTS ([a-z0-9_]+) \(([\s\S]*?)\)\s*ENGINE/giu)) {
    const names = new Set<string>();
    for (const line of match[2].split("\n")) {
      const name = line.trim().match(/^([a-z_][a-z0-9_]*)/iu);
      if (name?.[1]) names.add(name[1]);
    }
    found.set(match[1], names);
  }
  return found;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const roots = process.argv.slice(2);
  const targets = roots.length ? roots : [path.join(repoRoot(), "knowledge", "lumenfox"), path.join(repoRoot(), "knowledge", "harborlight")];
  let failed = false;
  for (const root of targets) {
    const issues = diagnoseKnowledge(root);
    if (issues.length) {
      failed = true;
      for (const issue of issues) console.error(`${root} ${issue.code}: ${issue.message}`);
    } else {
      console.log(`${root} 知识体检通过。只做检查，没有修改知识文件。`);
    }
  }
  if (failed) process.exit(1);
}
