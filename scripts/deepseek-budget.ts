import path from "node:path";
import { mkdir } from "node:fs/promises";
import { repoRoot } from "../src/config.js";
import { GlobalBudget } from "../src/global-budget.js";

// A deliberate operator action, never invoked by API/worker startup.
const [command, budgetId, requestText, tokenText, argument] = process.argv.slice(2);
const maxRequests = Number(requestText), maxTokens = Number(tokenText);
if (!budgetId || !["activate", "status", "close", "acknowledge"].includes(command ?? "") || !Number.isSafeInteger(maxRequests) || maxRequests < 1 || !Number.isSafeInteger(maxTokens) || maxTokens < 1 || (command === "acknowledge" ? !argument : argument && !(command === "close" && argument === "acknowledge-unknown"))) {
  throw new Error("用法: npm run budget -- activate|status|close 范围ID 请求数 token数 [acknowledge-unknown]；或 acknowledge 范围ID 请求数 token数 step_id");
}
const dir = path.join(repoRoot(), ".local-runtime");
if (command === "activate") await mkdir(dir, { recursive: true, mode: 0o700 });
const options = { path: path.join(dir, "deepseek-budget.sqlite"), budgetId, maxRequests, maxTokens };
const budget = command === "activate" ? await GlobalBudget.activate(options) : await GlobalBudget.open(options);
try {
  if (command === "close") {
    const result = await budget.closeScope(argument === "acknowledge-unknown");
    if (!result.ok) throw new Error(result.code);
    console.log("预算范围已关闭，历史保留。");
  } else if (command === "acknowledge") {
    const result = await budget.acknowledgeInterrupted(argument!);
    if (!result.ok) throw new Error(result.code);
    console.log("中断请求已保留为用量未知，不会释放占额。");
  } else console.log(JSON.stringify({ ...(await budget.stats()), pending: await budget.pendingSteps() }));
} finally { await budget.close(); }
