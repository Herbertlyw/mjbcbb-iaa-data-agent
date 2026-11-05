import { isCalendarDate } from "./config.js";

/** Check the saved grouped result itself, not just a separate coverage read.
 * IN domains and every day for each returned group must be represented;
 * unknown dimension values are never invented. */
export function completeObservedGroups(groups: ReadonlyArray<Record<string, string>>, groupedBy: readonly string[], inSets: Readonly<Record<string, readonly string[]>>, dateColumn: string | undefined, range: { start: string; end: string }): boolean {
  if (!groups.length || new Set(groupedBy).size !== groupedBy.length) return false;
  const domains = Object.entries(inSets);
  let expected: string[][] = [[]];
  for (const [name, values] of domains) {
    if (!groupedBy.includes(name) || !Array.isArray(values) || !values.length || values.some((value) => typeof value !== "string") || new Set(values).size !== values.length || expected.length * values.length > 10_000) return false;
    expected = expected.flatMap((entry) => values.map((value) => [...entry, value]));
  }
  if (domains.length) {
    const observed = new Set(groups.map((group) => JSON.stringify(domains.map(([name]) => group[name]))));
    if (expected.some((values) => !observed.has(JSON.stringify(values)))) return false;
  }
  if (dateColumn && groupedBy.includes(dateColumn)) {
    if (!isCalendarDate(range.start) || !isCalendarDate(range.end)) return false;
    const days = (Date.parse(`${range.end}T00:00:00Z`) - Date.parse(`${range.start}T00:00:00Z`)) / 86_400_000 + 1;
    if (!Number.isSafeInteger(days) || days < 1 || days > 100_000) return false;
    const other = groupedBy.filter((name) => name !== dateColumn);
    const datesByKey = new Map<string, Set<string>>();
    for (const group of groups) {
      const date = group[dateColumn]; if (!date || !isCalendarDate(date) || date < range.start || date > range.end) return false;
      const key = JSON.stringify(other.map((name) => group[name]));
      const dates = datesByKey.get(key) ?? new Set<string>(); dates.add(date); datesByKey.set(key, dates);
    }
    if ([...datesByKey.values()].some((dates) => dates.size !== days)) return false;
  }
  return true;
}
