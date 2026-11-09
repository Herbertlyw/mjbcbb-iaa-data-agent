// Bound response previews independently of the persisted evidence budget.
import type { CoverageReport } from "./types.js";

/** Full coverage stays in the resource; model/API responses receive a bounded
 * preview with an explicit count, never a claim that omitted groups are absent. */
export function coveragePreview(report: CoverageReport): CoverageReport {
  const groups: CoverageReport["groups"] = [];
  let bytes = 0;
  for (const group of report.groups.slice(0, 20)) {
    const size = Buffer.byteLength(JSON.stringify(group));
    if (bytes + size > 8000) break;
    groups.push(group);
    bytes += size;
  }
  return {
    ...report,
    groups,
    groups_total: report.groups.length,
    groups_has_more: report.groups.length > groups.length,
    ...(report.per_table ? { per_table: report.per_table.map(coveragePreview) } : {}),
  };
}

/** Keep response payloads bounded independently of the saved result budget. */
export function previewRows<T>(rows: T[], limit: number): T[] {
  const preview: T[] = [];
  let bytes = 2;
  for (const row of rows.slice(0, limit)) {
    const size = Buffer.byteLength(JSON.stringify(row)) + 1;
    if (bytes + size > 32_000) break;
    preview.push(row);
    bytes += size;
  }
  return preview;
}
