import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export function openSimulatedDatabase(filePath: string, seedSql: string, options: { reseed?: boolean } = {}): DatabaseSync {
  mkdirSync(path.dirname(filePath), { recursive: true });
  if (options.reseed !== false) {
    const writer = new DatabaseSync(filePath);
    writer.exec(seedSql);
    writer.close();
  }
  return new DatabaseSync(filePath, { readOnly: true });
}

export function plainRows(rows: unknown[]): Array<Record<string, unknown>> {
  return rows.map((row) => {
    const record: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(row as object)) record[key] = value;
    return record;
  });
}
