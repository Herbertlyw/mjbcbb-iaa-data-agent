import assert from "node:assert/strict";
import test from "node:test";
import { rollingWarehouse } from "../src/warehouse.js";

test("滚动合成仓库按洛杉矶日期整体平移并保留缺失、零和预测", () => {
  const before = rollingWarehouse({ now: new Date("2027-02-15T07:59:00Z") });
  const after = rollingWarehouse({ now: new Date("2027-02-15T08:01:00Z") });
  const fixed = rollingWarehouse({ simulatedToday: "2027-02-15" });
  const current = (data: typeof fixed) => data.installs.filter((row) => row.title_id === "paper_lantern" && row.country_code === "US" && row.channel_id === "mist_ads");
  assert.equal(current(before).at(-1)?.event_date, "2027-01-28");
  assert.equal(current(after).at(-1)?.event_date, "2027-01-29");
  assert.deepEqual(after, fixed);
  assert.equal(current(after).find((row) => row.event_date === "2027-01-26")?.new_users, null);
  assert.equal(current(after).find((row) => row.event_date === "2027-01-24")?.new_users, 0);
  assert.ok(after.revenue.some((row) => row.is_predicted === 1));
  assert.equal(after.retention[0]?.cohort_date, "2027-01-23");
  assert.throws(() => rollingWarehouse({ simulatedToday: "2027-02-30" }), /invalid_synthetic_clock/);
});
