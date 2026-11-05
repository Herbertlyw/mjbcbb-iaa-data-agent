import { createHash } from "node:crypto";
import type { SessionResource } from "./types.js";

type Lookup = (id: string) => Promise<{ ok: true; resource: SessionResource } | { ok: false; code: string }>;
export type ResourceGraphError = "resource_dependency_cycle" | "resource_dependency_limit" | "resource_dependency_invalid" | "resource_dependency_changed" | "resource_from_other_execution" | string;
export const resourceHash = (resource: SessionResource): string => createHash("sha256").update(JSON.stringify(resource)).digest("hex");

/** A request-local dependency snapshot. Never reuse it across authorization or
 * freshness checks. Shared nodes are read once; failed roots leave no partial
 * closure behind. The caller must still revalidate leaves and recompute nodes. */
export class ResourceGraph {
  private readonly loaded = new Map<string, SessionResource>();
  private readonly complete = new Map<string, SessionResource>();
  private readonly active = new Set<string>();
  private readonly ordered: SessionResource[] = [];
  constructor(private readonly lookup: Lookup, private readonly sessionId: string, private readonly jobId?: string) {}

  nodes(): readonly SessionResource[] { return this.ordered; }

  async add(root: string): Promise<ResourceGraphError | null> {
    const checkpoint = this.ordered.length;
    const error = await this.visit(root, this.jobId);
    if (error) {
      this.ordered.splice(checkpoint);
      this.complete.clear();
      for (const retained of this.ordered) this.complete.set(retained.resource_id, retained);
      this.active.clear();
    }
    return error;
  }

  private async visit(id: string, expectedJob?: string): Promise<ResourceGraphError | null> {
    if (typeof id !== "string" || !id || id.length > 128) return "resource_dependency_invalid";
    const completed = this.complete.get(id);
    if (completed) return expectedJob && completed.job_id !== expectedJob ? "resource_from_other_execution" : null;
    if (this.active.has(id)) return "resource_dependency_cycle";
    if (this.complete.size + this.active.size >= 128 || this.active.size >= 16) return "resource_dependency_limit";
    let resource = this.loaded.get(id);
    if (!resource) {
      const found = await this.lookup(id);
      if (!found.ok) return found.code;
      resource = found.resource;
      if (resource.resource_id !== id || resource.session_id !== this.sessionId) return "resource_dependency_invalid";
      this.loaded.set(id, resource);
    }
    if (expectedJob && resource.job_id !== expectedJob) return "resource_from_other_execution";
    this.active.add(id);
    let parents: string[];
    if (resource.kind === "query_result") parents = [];
    else if (resource.kind === "calculation" || resource.kind === "transform") parents = [resource.source_resource_id];
    else if (resource.kind === "arithmetic") parents = [resource.left?.resource_id, resource.right?.resource_id];
    else if (resource.kind === "alignment") parents = [resource.spec?.left?.resource_id, resource.spec?.right?.resource_id];
    else return "resource_dependency_invalid";
    for (const parent of new Set(parents)) {
      const error = await this.visit(parent, resource.job_id ?? expectedJob);
      if (error) return error;
    }
    if (resource.kind === "calculation") {
      const parent = this.complete.get(resource.source_resource_id);
      if (!parent || (!resource.evaluated_table_v1 && parent.kind !== "query_result") || !resource.source_resource_hash || resource.source_resource_hash !== resourceHash(parent)) return "resource_dependency_changed";
    }
    this.active.delete(id);
    this.complete.set(id, resource);
    this.ordered.push(resource);
    return null;
  }
}
