import { randomUUID } from "node:crypto";
import type { AsyncMysqlStateStore } from "./async-mysql-state-store.js";

/** Process activity is not a job lease. Each incarnation gets a new identity;
 * the database supplies time, so a dead process expires without reviving work. */
export function recordExecutorActivity(kind: "worker" | "dispatcher", state: () => Promise<AsyncMysqlStateStore>) {
  const id = randomUUID();
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: Promise<void> | undefined;
  const tick = () => {
    if (stopped || pending) return;
    pending = (async () => { await (await state()).call("executorHeartbeat", kind, id); })()
      .catch(() => undefined)
      .finally(() => { pending = undefined; if (!stopped) timer = setTimeout(tick, 3000); });
  };
  tick();
  const stop = async () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    await pending;
    // Opening a replacement bridge can fail as well as the operation itself.
    // Neither failure should prevent the rest of the process shutdown.
    try { await (await state()).call("executorStop", kind, id); } catch { /* stale activity expires by database time */ }
  };
  stop.progress = async () => {
    if (stopped) return;
    await (await state()).call("executorProgress", kind, id);
  };
  return stop;
}
