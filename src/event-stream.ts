// Stream bounded persisted event pages, pausing database reads while the socket is full.
import { once } from "node:events";
import type { ServerResponse } from "node:http";
import { setTimeout as delay, setImmediate as yieldToIo } from "node:timers/promises";
import type { JobEventPage } from "./history-page.mjs";
import { isTerminal } from "./types.js";

export async function streamEventPages(res: ServerResponse, first: JobEventPage, after: number, read: (after: number) => Promise<JobEventPage>): Promise<void> {
  if (res.destroyed || res.writableEnded) return;
  const controller = new AbortController();
  const close = () => controller.abort();
  res.once("close", close);
  res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", connection: "keep-alive" });
  res.flushHeaders();
  let page = first;
  let cursor = after;
  try {
    while (!controller.signal.aborted) {
      for (const event of page.events) {
        if (controller.signal.aborted) return;
        const accepted = res.write(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`);
        cursor = event.seq;
        if (!accepted) {
          // A stalled reader reconnects from its own last received cursor; the
          // server never queues another page behind an undrained socket.
          await once(res, "drain", { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]) });
        }
      }
      if (!page.has_more && isTerminal(page.head.status)) break;
      if (page.has_more) await yieldToIo(undefined, { signal: controller.signal });
      else await delay(150, undefined, { signal: controller.signal });
      if (controller.signal.aborted) return;
      page = await read(cursor);
    }
  } catch {
    // Never send an invented persisted event or a JSON error inside an SSE
    // stream. Closing lets the client resume from its last contiguous seq.
  } finally {
    res.removeListener("close", close);
    controller.abort();
    if (!res.destroyed && !res.writableEnded) res.end();
  }
}
