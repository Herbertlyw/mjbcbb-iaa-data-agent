import { randomUUID } from "node:crypto";
import type { Agent } from "@earendil-works/pi-agent-core";
import type { ExecutionLease, StateStore, StoredSession } from "./state-store.js";
import type { SessionResource } from "./types.js";

export interface SessionRecord extends StoredSession {
  active_job_id?: string;
  agent?: Agent;
}

export class SessionStore {
  private readonly agents = new Map<string, Agent>();
  private readonly activeJobs = new Map<string, string>();
  private readonly activeLeases = new Map<string, ExecutionLease>();
  private revisionFn: ((jobId: string) => number | "lost" | "memory") | null = null;

  setRevisionFn(fn: (jobId: string) => number | "lost" | "memory"): void {
    this.revisionFn = fn;
  }

  consumeRevision(jobId: string): number | "lost" | "memory" {
    return this.revisionFn ? this.revisionFn(jobId) : "memory";
  }

  reserveToolCall(sessionId: string, maxCalls: number): "ok" | "budget_exhausted" | "lost" {
    const lease = this.activeLeases.get(sessionId);
    return lease ? this.state.reserveToolCall(sessionId, lease, maxCalls) : "ok";
  }

  constructor(private readonly state: StateStore) {}

  create(role: string, title = "新会话", actorId = role === "viewer" ? "demo-viewer" : "demo-analyst"): SessionRecord {
    const session: StoredSession = {
      session_id: `ses_${randomUUID()}`,
      title,
      role,
      actor_id: actorId,
      created_at: new Date().toISOString(),
      slots: null,
      bindings: [],
    };
    this.state.createSession(session);
    return this.require(session.session_id);
  }

  list(actorId?: string): SessionRecord[] {
    return this.state
      .listSessions()
      .filter((session) => !actorId || (session.actor_id ?? "demo-analyst") === actorId)
      .map((session) => this.hydrate(session));
  }

  require(sessionId: string): SessionRecord {
    const session = this.state.getSession(sessionId);
    if (!session) throw new Error("session_not_found");
    return this.hydrate(session);
  }

  save(session: SessionRecord): void {
    this.state.saveSession(storedSession(session), this.activeLeases.get(session.session_id));
  }

  rememberAgent(sessionId: string, agent: Agent): void {
    this.agents.set(sessionId, agent);
  }

  agentFor(sessionId: string): Agent | undefined {
    return this.agents.get(sessionId);
  }

  setActiveJob(sessionId: string, jobId: string | undefined, authority?: { owner: string; fence: number }): void {
    if (jobId) {
      this.activeJobs.set(sessionId, jobId);
      if (authority) this.activeLeases.set(sessionId, { jobId, ...authority });
      else this.activeLeases.delete(sessionId);
    } else {
      this.activeJobs.delete(sessionId);
      this.activeLeases.delete(sessionId);
    }
  }

  saveResource(resource: SessionResource): SessionResource {
    this.state.saveResource(resource, this.activeLeases.get(resource.session_id));
    return resource;
  }

  lookupResource(
    sessionId: string,
    resourceId: string,
  ): { ok: true; resource: SessionResource } | { ok: false; code: "resource_not_found" | "cross_session_resource"; message: string } {
    const resource = this.state.getResource(resourceId);
    if (!resource) return { ok: false, code: "resource_not_found", message: "会话里没有这个资源" };
    if (resource.session_id !== sessionId) {
      return { ok: false, code: "cross_session_resource", message: "不能读取其他会话的资源" };
    }
    return { ok: true, resource };
  }

  resourceCount(): number {
    return this.state.countResources();
  }

  private hydrate(session: StoredSession): SessionRecord {
    return {
      ...session,
      bindings: session.bindings,
      ...(this.activeJobs.has(session.session_id) ? { active_job_id: this.activeJobs.get(session.session_id) } : {}),
      ...(this.agents.has(session.session_id) ? { agent: this.agents.get(session.session_id) } : {}),
    };
  }
}

export function storedSession(session: SessionRecord): StoredSession {
  return {
    session_id: session.session_id,
    title: session.title,
    role: session.role,
    actor_id: session.actor_id,
    created_at: session.created_at,
    slots: session.slots,
    bindings: session.bindings,
  };
}

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}
