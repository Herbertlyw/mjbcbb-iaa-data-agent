import { shiftSyntheticDates, syntheticDayShift } from "./synthetic-clock.js";

/** Reproducible fixture SQL for a newly created, disposable synthetic database.
 * Four days and two channels contain 100,000 rows in total. The data is
 * generated inside ClickHouse; neither a large file nor user data is needed.
 * This function does not connect to or alter a database by itself. */
export function largeSyntheticInstallSql(fixtureToday = "2026-10-29"): string {
  const start = shiftSyntheticDates("2026-10-06", syntheticDayShift(fixtureToday));
  return `INSERT INTO fact_fox_daily_install SELECT toDate('${start}') + toUInt16(number % 4), 'big_demo', 'android', concat('S', toString(intDiv(number, 8))), if(intDiv(number, 4) % 2 = 0, 'mist_ads', 'pebble_net'), toInt32(2 * intDiv(number, 8) + 1 + intDiv(number, 4) % 2), NULL FROM numbers(100000)`;
}
