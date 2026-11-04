import { GlobalBudget, type GlobalBudgetOptions } from "../src/global-budget.js";

const options = JSON.parse(process.argv[2]!) as GlobalBudgetOptions;
const stepId = process.argv[3]!;
const mode = process.argv[4] ?? "race";
const gate = await GlobalBudget.open(options);
const result = await gate.reserve({ stepId, jobId: `job_${stepId}`, estimatedInput: 100, reservedOutput: 100 });
if (mode === "crash" && result.ok) {
  const dispatched = await gate.markDispatched(stepId);
  process.stdout.write(`${JSON.stringify({ result, dispatched })}\n`);
  setInterval(() => {}, 1000);
} else {
  await gate.close();
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
