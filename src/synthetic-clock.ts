import { isCalendarDate } from "./config.js";

/** The local synthetic fixture is anchored at this simulated business day. */
export const SYNTHETIC_FIXTURE_DAY = "2026-10-29";

export function syntheticDayShift(today: string): number {
  if (!isCalendarDate(today) || today < "1971-01-01" || today > "2148-12-31") throw new Error("invalid_synthetic_clock");
  return (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${SYNTHETIC_FIXTURE_DAY}T00:00:00Z`)) / 86_400_000;
}

/** Only for fixture examples and the scripted fake provider, never a real prompt rewrite. */
export function shiftSyntheticDates(text: string, days: number): string {
  if (!Number.isSafeInteger(days) || Math.abs(days) > 70_000) throw new Error("invalid_synthetic_clock");
  return text.replace(/\b\d{4}-\d{2}-\d{2}\b/gu, (value) => {
    if (!isCalendarDate(value)) return value;
    const shifted = new Date(Date.parse(`${value}T00:00:00Z`) + days * 86_400_000);
    if (!Number.isFinite(shifted.getTime())) throw new Error("invalid_synthetic_clock");
    return shifted.toISOString().slice(0, 10);
  });
}
