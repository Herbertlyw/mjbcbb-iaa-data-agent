import { MysqlFreshnessStore, type FreshnessManifest } from "../src/mysql-freshness.js";
import type { FreshnessObservation } from "../src/freshness.js";

const store = await MysqlFreshnessStore.open({
  host: "127.0.0.1",
  port: Number(process.env.MYSQL_PORT),
  user: process.env.MYSQL_USER ?? "",
  password: process.env.MYSQL_PASSWORD ?? "",
  database: process.env.MYSQL_DATABASE ?? "",
});

process.on("message", (input: { action: string; manifest?: FreshnessManifest; version?: number; observation?: FreshnessObservation }) => {
  void (async () => {
    try {
      if (input.action === "begin" && input.manifest) process.send?.({ ok: true, batch: await store.begin(input.manifest) });
      else if (input.action === "publish" && input.version && input.observation) process.send?.({ ok: true, result: await store.publish(input.version, input.observation) });
      else if (input.action === "close") { await store.close(); process.send?.({ ok: true }); process.disconnect?.(); }
      else process.send?.({ ok: false });
    } catch { process.send?.({ ok: false }); }
  })();
});
process.send?.({ ok: true, ready: true });
