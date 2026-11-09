import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { ServerResponse } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { streamEventPages } from "../src/event-stream.js";
import type { JobEventPage } from "../src/history-page.mjs";
import { startServer } from "../src/server.js";
import { withRuntime } from "./helpers.js";

function page(seq: number, terminal = false): JobEventPage {
  return { head: { job_id: "j", session_id: "s", status: terminal ? "completed" : "running", last_seq: seq }, events: [{ seq, type: terminal ? "job_finished" : "tool_finished", at: "2026-11-09T00:00:00.000Z", payload: {} }], has_more: false };
}

class Socket extends EventEmitter {
  destroyed = false; writableEnded = false; full = true; frames: string[] = [];
  writeHead() {} flushHeaders() {}
  write(frame: string) { this.frames.push(frame); return !this.full; }
  end() { this.writableEnded = true; this.emit("close"); }
}

test("SSE 背压期间不预读下一页，drain 后续读；断开移除监听且停止轮询", async () => {
  const socket = new Socket();
  let reads = 0;
  // Deliberately model only the ServerResponse methods used by the streamer.
  const pending = streamEventPages(socket as unknown as ServerResponse, page(1), 0, async () => { reads++; return page(2, true); });
  await delay(25);
  assert.equal(socket.frames.length, 1); assert.equal(reads, 0);
  socket.full = false; socket.emit("drain"); await pending;
  assert.equal(reads, 1); assert.equal(socket.frames.length, 2);
  assert.equal(socket.listenerCount("close"), 0); assert.equal(socket.listenerCount("drain"), 0);
  const closed = new Socket();
  const abandoned = streamEventPages(closed as unknown as ServerResponse, page(1), 0, async () => { throw new Error("must_not_read"); });
  closed.destroyed = true; closed.emit("close"); await abandoned;
  assert.equal(closed.listenerCount("drain"), 0); assert.equal(closed.listenerCount("close"), 0);
});

test("SSE 按页重放 100 多条事件，不读取完整任务；非法 after 在响应头前拒绝", async () => {
  await withRuntime({ startWorker: false }, async runtime => {
    const session = runtime.sessions.create("analyst");
    const job = runtime.jobs.submit(session.session_id, "合成 SSE 分页", "events");
    const claim = runtime.state.claimJob(job.job_id, "events-owner", Date.now(), 30_000); assert.ok(claim);
    for (let n = 0; n < 110; n++) assert.ok(runtime.state.appendEvent(job.job_id, claim.owner, claim.fence, "tool_finished", { message: "合成", padding: "中".repeat(8000) }));
    assert.equal(runtime.state.finish(job.job_id, claim.owner, claim.fence, "completed", null, null), true);
    const originalGet = runtime.state.getJob.bind(runtime.state);
    runtime.state.getJob = () => { throw new Error("stream_must_not_load_full_job"); };
    const server = startServer(runtime);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address(); assert.ok(address && typeof address === "object");
    const base = `http://127.0.0.1:${address.port}/api/jobs/${job.job_id}/events`;
    try {
      let cursor = 0; let pages = 0;
      while (cursor < 112) {
        const current = runtime.state.readJobEvents(job.job_id, cursor); assert.ok(current);
        assert.ok(current.events.length <= 32);
        assert.ok(Buffer.byteLength(JSON.stringify(current.events)) < 131072);
        cursor = current.events.at(-1)!.seq; pages++;
      }
      assert.ok(pages > 20);
      for (const invalid of ["NaN", "Infinity", "-1", "1.1", "9007199254740992", "113", ""]) {
        const response = await fetch(`${base}?after=${invalid}`);
        assert.equal(response.status, 400, invalid);
        assert.match(response.headers.get("content-type") ?? "", /application\/json/);
      }
      const forbidden = await fetch(base, { headers: { "x-demo-actor": "demo-viewer" } }); assert.equal(forbidden.status, 404);
      const initial = await fetch(`${base}?after=0`);
      const reader = initial.body!.getReader();
      const firstChunk = await reader.read();
      const received = new TextDecoder().decode(firstChunk.value);
      assert.match(received, /"seq":1/);
      await reader.cancel();
      const rest = await (await fetch(`${base}?after=1`)).text();
      const seqs = [...rest.matchAll(/^id: (\d+)$/gm)].map(match => Number(match[1]));
      assert.deepEqual(seqs, Array.from({ length: 111 }, (_, i) => i + 2));
      assert.equal((rest.match(/"type":"job_finished"/g) ?? []).length, 1);
      const ended = await (await fetch(`${base}?after=112`)).text(); assert.equal(ended, "");
    } finally {
      runtime.state.getJob = originalGet;
      server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});
