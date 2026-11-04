import assert from "node:assert/strict";
import test from "node:test";
import { largeSyntheticInstallSql } from "../src/synthetic-large.js";

test("大样本生成器只构造固定 100000 行的合成 SQL，日期随模拟时钟平移", () => {
  const fixed = largeSyntheticInstallSql();
  assert.match(fixed, /^INSERT INTO fact_fox_daily_install SELECT /u);
  assert.match(fixed, /toDate\('2026-10-06'\)/u);
  assert.match(fixed, /FROM numbers\(100000\)$/u);
  assert.match(largeSyntheticInstallSql("2027-02-15"), /toDate\('2027-01-23'\)/u);
  assert.throws(() => largeSyntheticInstallSql("2027-02-30"), /invalid_synthetic_clock/u);
  assert.throws(() => largeSyntheticInstallSql("2026-10-29' OR 1=1"), /invalid_synthetic_clock/u);
});
