import assert from "node:assert/strict";
import test from "node:test";
import { canContinueTranscript, withoutUnfinishedToolCall } from "../src/agent.js";
import { analyst, ask, withRuntime } from "./helpers.js";

test("Pi 公开消息记录可以恢复，失权 worker 不能写快照，faux 用量保持未知", async () => {
  const messages = [
    { role: "user", content: "问题" },
    { role: "assistant", content: [{ type: "toolCall", id: "1", name: "search_assets", arguments: {} }] },
  ];
  const dropped = withoutUnfinishedToolCall(messages);
  assert.equal(dropped.length, 1);
  assert.equal(canContinueTranscript(dropped), true);
  assert.equal(canContinueTranscript([{ role: "toolResult", toolName: "read_asset" }]), true);

  await withRuntime({ maxContextChars: 20 }, async (runtime) => {
    const session = analyst(runtime);
    const job = await ask(runtime, session.session_id, "看看收入");
    assert.equal(job.status, "failed");
    assert.equal(job.error?.code, "budget_exhausted");
    assert.equal(job.usage?.input_tokens, null);
    assert.equal(job.usage?.cost, null);
    assert.equal(job.usage?.usage_source, "faux_unmeasured");
  });

  await withRuntime({}, async (runtime) => {
    const session = analyst(runtime);
    const job = await ask(runtime, session.session_id, "看看收入");
    const settled = runtime.state.loadAgentSnapshot(session.session_id, { kind: "settled" });
    assert.equal(settled?.body.format, "pi-agent-state-messages-v1");
    const bodyMessages = settled?.body.messages as Array<{ role?: string }>;
    assert.ok(bodyMessages.some((message) => message.role === "assistant" || message.role === "user"));
    assert.equal(job.usage?.usage_source, "faux_unmeasured");
    const claim = runtime.state.claimJob(job.job_id, "stale-worker", Date.now(), 1000);
    assert.equal(claim, null);
    const wrote = runtime.state.saveAgentSnapshot({
      sessionId: session.session_id,
      jobId: job.job_id,
      owner: "stale-worker",
      fence: 1,
      kind: "progress",
      body: { format: "pi-agent-state-messages-v1" },
    });
    assert.equal(wrote, false);
  });
});
