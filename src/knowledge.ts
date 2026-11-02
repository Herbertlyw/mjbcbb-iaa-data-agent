import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { AccessPolicy, AssetRecord, DataContract, JoinConstraint, KnowledgeBase } from "./types.js";
import { isCalendarDate } from "./config.js";

interface RegistryFile {
  registry_revision: string;
  simulated: true;
  scenario: string;
  timezone: string;
  policy_path: string;
  seed_path: string;
  joins_path?: string;
  assets: Array<Omit<AssetRecord, "body" | "contract" | "content_hash">>;
}

export function loadKnowledge(root: string): KnowledgeBase {
  const registry = JSON.parse(readFileSync(path.join(root, "registry.json"), "utf8")) as RegistryFile;
  const policy = JSON.parse(readFileSync(path.join(root, registry.policy_path), "utf8")) as AccessPolicy;
  const assets: AssetRecord[] = registry.assets.map((entry) => {
    const body = readFileSync(path.join(root, entry.path), "utf8");
    const asset: AssetRecord = { ...entry, body, content_hash: createHash("sha256").update(body).digest("hex") };
    if (entry.kind === "data_contract") {
      const contract = JSON.parse(body) as DataContract;
      if (contract.asset_id !== entry.asset_id || contract.revision !== entry.revision || contract.table !== entry.table) {
        throw new Error(`契约 ${entry.asset_id} 与目录登记不一致`);
      }
      asset.contract = contract;
    }
    return asset;
  });
  const by_id = new Map(assets.map((asset) => [asset.asset_id, asset]));
  for (const role of Object.values(policy.roles)) {
    for (const assetId of role.read) {
      if (!by_id.has(assetId)) throw new Error(`权限引用了不存在的资产 ${assetId}`);
    }
  }
  const contract_by_table = new Map<string, AssetRecord>();
  const table_mentions = new Map<string, AssetRecord>();
  for (const asset of assets) {
    if (asset.table) table_mentions.set(asset.table, asset);
    if (asset.kind === "data_contract" && asset.table) contract_by_table.set(asset.table, asset);
  }
  return {
    registry_revision: registry.registry_revision,
    simulated: true,
    scenario: registry.scenario,
    timezone: registry.timezone,
    policy,
    assets,
    by_id,
    contract_by_table,
    table_mentions,
    joins: registry.joins_path
      ? ((JSON.parse(readFileSync(path.join(root, registry.joins_path), "utf8")) as { joins: JoinConstraint[] }).joins ?? [])
      : [],
    seed_sql: readFileSync(path.join(root, registry.seed_path), "utf8"),
  };
}

export function canRead(knowledge: KnowledgeBase, role: string, assetId: string): boolean {
  return knowledge.policy.roles[role]?.read.includes(assetId) ?? false;
}

export function canQueryTable(knowledge: KnowledgeBase, role: string, table: string): boolean {
  return knowledge.policy.roles[role]?.query_tables.includes(table) ?? false;
}

export function contractValidity(contract: DataContract, today: string): "invalid" | "not_yet_valid" | "expired" | null {
  if (!isCalendarDate(contract.valid_from) || !isCalendarDate(contract.valid_until) || contract.valid_from > contract.valid_until || !isCalendarDate(today)) return "invalid";
  if (today < contract.valid_from) return "not_yet_valid";
  if (contract.valid_until < today) return "expired";
  return null;
}

export function tableGrain(knowledge: KnowledgeBase, table: string): string[] {
  const contract = knowledge.contract_by_table.get(table)?.contract;
  if (!contract) return [];
  if (contract.grain?.length) return contract.grain.map((item) => item.toLowerCase());
  if (!contract.series) return [];
  return [contract.series.date_column, ...contract.series.dimensions].map((item) => item.toLowerCase());
}

export function joinForTables(knowledge: KnowledgeBase, tables: string[]): JoinConstraint | undefined {
  const wanted = [...tables].sort().join("|");
  return knowledge.joins.find((join) => [...join.tables].sort().join("|") === wanted);
}
