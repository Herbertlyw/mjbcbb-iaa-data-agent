import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
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

interface KnowledgeSource {
  relative: string;
  resolved: string;
  hash: string;
}

interface KnowledgeSources {
  root: string;
  common: KnowledgeSource[];
  assets: Map<string, KnowledgeSource>;
}

// This is host-owned provenance, not a model-provided receipt. It is scoped to
// the in-memory knowledge instance and is never included in tool responses.
const sourceSnapshots = new WeakMap<KnowledgeBase, KnowledgeSources>();
const sha256 = (body: Buffer) => createHash("sha256").update(body).digest("hex");

function isUnder(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function safeRelative(relative: string): boolean {
  return typeof relative === "string" && relative.length > 0 && !relative.includes("\\") && !path.isAbsolute(relative)
    && relative.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

function readKnowledgeFile(root: string, relative: string): { source: KnowledgeSource; body: Buffer } {
  if (!safeRelative(relative)) throw new Error("knowledge_path_invalid");
  const resolved = realpathSync(path.resolve(root, relative));
  if (!isUnder(root, resolved) || !statSync(resolved).isFile()) throw new Error("knowledge_path_outside_root");
  const body = readFileSync(resolved);
  return { source: { relative, resolved, hash: sha256(body) }, body };
}

/** Recheck formal sources asynchronously before a tool uses a saved receipt.
 * A caller supplies only assets the current principal may inspect. The registry,
 * access policy and JOIN rules are always rechecked. This detects replacement,
 * path redirection and changed bytes; it is not a filesystem transaction or a
 * defense against an administrator changing files immediately after the check. */
export async function validateKnowledgeSources(knowledge: KnowledgeBase, assetIds: readonly string[] = []): Promise<boolean> {
  const snapshot = sourceSnapshots.get(knowledge);
  if (!snapshot || !Array.isArray(assetIds)) return false;
  const selected: KnowledgeSource[] = [...snapshot.common];
  for (const assetId of new Set(assetIds)) {
    if (typeof assetId !== "string") return false;
    const source = snapshot.assets.get(assetId);
    if (!source) return false;
    selected.push(source);
  }
  try {
    // Keep filesystem concurrency bounded even if the catalog contains many
    // assets; a changed file fails the operation closed without leaking it.
    for (let offset = 0; offset < selected.length; offset += 16) {
      const valid = await Promise.all(selected.slice(offset, offset + 16).map(async (source) => {
        const actual = await realpath(path.resolve(snapshot.root, source.relative));
        if (actual !== source.resolved || !isUnder(snapshot.root, actual) || !(await stat(actual)).isFile()) return false;
        return sha256(await readFile(actual)) === source.hash;
      }));
      if (!valid.every(Boolean)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

export function loadKnowledge(root: string): KnowledgeBase {
  const resolvedRoot = realpathSync(root);
  if (!statSync(resolvedRoot).isDirectory()) throw new Error("knowledge_root_invalid");
  const registryFile = readKnowledgeFile(resolvedRoot, "registry.json");
  const registry = JSON.parse(registryFile.body.toString("utf8")) as RegistryFile;
  if (registry.simulated !== true || !Array.isArray(registry.assets)) throw new Error("knowledge_registry_invalid");
  const policyFile = readKnowledgeFile(resolvedRoot, registry.policy_path);
  const policy = JSON.parse(policyFile.body.toString("utf8")) as AccessPolicy;
  if (policy.simulated !== true || !policy.roles || typeof policy.roles !== "object") throw new Error("knowledge_policy_invalid");
  const sourceMap = new Map<string, KnowledgeSource>();
  const usedPaths = new Set<string>();
  const assets: AssetRecord[] = registry.assets.map((entry) => {
    if (!entry || typeof entry.asset_id !== "string" || !entry.asset_id || sourceMap.has(entry.asset_id)) throw new Error("knowledge_duplicate_or_invalid_asset_id");
    const file = readKnowledgeFile(resolvedRoot, entry.path);
    if (usedPaths.has(file.source.resolved)) throw new Error("knowledge_duplicate_asset_path");
    usedPaths.add(file.source.resolved);
    sourceMap.set(entry.asset_id, file.source);
    const body = file.body.toString("utf8");
    const asset: AssetRecord = { ...entry, body, content_hash: file.source.hash };
    if (entry.kind === "data_contract") {
      const contract = JSON.parse(body) as DataContract;
      if (contract.simulated !== true || contract.asset_id !== entry.asset_id || contract.revision !== entry.revision || contract.table !== entry.table) {
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
  const contractTableNames = new Set<string>();
  const table_mentions = new Map<string, AssetRecord>();
  for (const asset of assets) {
    if (asset.table) table_mentions.set(asset.table, asset);
    if (asset.kind === "data_contract" && asset.table) {
      const name = asset.table.toLowerCase();
      if (contractTableNames.has(name)) throw new Error("knowledge_duplicate_contract_table");
      contractTableNames.add(name);
      contract_by_table.set(asset.table, asset);
    }
  }
  const joinsFile = registry.joins_path ? readKnowledgeFile(resolvedRoot, registry.joins_path) : null;
  const seedFile = readKnowledgeFile(resolvedRoot, registry.seed_path);
  const knowledge: KnowledgeBase = {
    registry_revision: registry.registry_revision,
    simulated: true,
    scenario: registry.scenario,
    timezone: registry.timezone,
    policy,
    assets,
    by_id,
    contract_by_table,
    table_mentions,
    joins: joinsFile
      ? ((JSON.parse(joinsFile.body.toString("utf8")) as { joins: JoinConstraint[] }).joins ?? [])
      : [],
    seed_sql: seedFile.body.toString("utf8"),
  };
  sourceSnapshots.set(knowledge, { root: resolvedRoot, common: [registryFile.source, policyFile.source, ...(joinsFile ? [joinsFile.source] : [])], assets: sourceMap });
  return knowledge;
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
