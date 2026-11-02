import { randomUUID } from "node:crypto";
import mysql, { type Pool, type ResultSetHeader, type RowDataPacket } from "mysql2/promise";
import { dimensionSnapshotStatusValid, type FreshnessPublication } from "./freshness.js";
import type { MysqlConnection } from "./mysql-state-store.js";

export interface FreshnessManifest {
  registry_revision: string;
  target_hash: string;
  contract_hashes: Record<string, string>;
  target_tables: string[];
  dimension_targets?: Record<string, { key_columns: string[]; snapshot_columns: string[] }>;
}

export interface MysqlFreshnessPublication extends FreshnessPublication {
  manifest: FreshnessManifest;
}

/** Shared immutable observations. The database allocates sequence numbers before
 * probing; a later-started batch can never be replaced by an earlier batch. */
export class MysqlFreshnessStore {
  private readonly pool: Pool;
  private constructor(connection: MysqlConnection, private readonly timeoutMs: number) {
    if (connection.host !== "127.0.0.1") throw new Error("freshness_mysql_loopback_only");
    this.pool = mysql.createPool({ ...connection, connectionLimit: 4, waitForConnections: true, queueLimit: 32, connectTimeout: 5000 });
  }

  static async open(connection: MysqlConnection, timeoutMs = 10_000): Promise<MysqlFreshnessStore> {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw new Error("invalid_freshness_timeout");
    const store = new MysqlFreshnessStore(connection, timeoutMs);
    try {
      await store.deadline(store.pool.query(`CREATE TABLE IF NOT EXISTS freshness_batches (
        version BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
        publication_id VARCHAR(64) NOT NULL UNIQUE,
        state VARCHAR(16) NOT NULL,
        manifest_json LONGTEXT NOT NULL,
        result_json LONGTEXT NULL,
        created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        published_at DATETIME(3) NULL
      ) ENGINE=InnoDB`));
      await store.deadline(store.pool.query(`CREATE TABLE IF NOT EXISTS freshness_pointer (
        singleton TINYINT NOT NULL PRIMARY KEY,
        version BIGINT NULL
      ) ENGINE=InnoDB`));
      await store.deadline(store.pool.query("INSERT INTO freshness_pointer (singleton, version) VALUES (1, NULL) ON DUPLICATE KEY UPDATE singleton = singleton"));
      return store;
    } catch (error) {
      await store.deadline(store.pool.end()).catch(() => undefined);
      throw error;
    }
  }

  async begin(manifest: FreshnessManifest): Promise<{ version: number; publication_id: string }> {
    if (!manifest.registry_revision || !/^[a-f0-9]{64}$/u.test(manifest.target_hash) || !manifest.target_tables.length || new Set(manifest.target_tables).size !== manifest.target_tables.length || manifest.target_tables.some((table) => !/^[a-z_][a-z0-9_]*$/u.test(table)) || Object.values(manifest.contract_hashes).some((hash) => !/^[a-f0-9]{64}$/u.test(hash)) || Object.keys(manifest.dimension_targets ?? {}).some((table) => !manifest.target_tables.includes(table) || !manifest.contract_hashes[table])) {
      throw new Error("invalid_freshness_manifest");
    }
    const id = `fp_${randomUUID()}`;
    const [inserted] = await this.deadline(this.pool.query<ResultSetHeader>("INSERT INTO freshness_batches (publication_id, state, manifest_json) VALUES (?, 'pending', ?)", [id, JSON.stringify(manifest)]));
    if (!Number.isSafeInteger(inserted.insertId) || inserted.insertId < 1) throw new Error("invalid_freshness_version");
    return { version: inserted.insertId, publication_id: id };
  }

  async publish(version: number, result: Omit<FreshnessPublication, "publication_id" | "version" | "published_at">): Promise<"published" | "superseded"> {
    return this.deadline(this.publishTransaction(version, result));
  }

  private async publishTransaction(version: number, result: Omit<FreshnessPublication, "publication_id" | "version" | "published_at">): Promise<"published" | "superseded"> {
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      const [batchRows] = await conn.query<RowDataPacket[]>("SELECT * FROM freshness_batches WHERE version = ? FOR UPDATE", [version]);
      const batch = batchRows[0];
      if (!batch || batch.state !== "pending") throw new Error("freshness_batch_not_pending");
      const manifest = JSON.parse(String(batch.manifest_json)) as FreshnessManifest;
      if (JSON.stringify(Object.keys(result.tables).sort()) !== JSON.stringify([...manifest.target_tables].sort())) throw new Error("freshness_batch_incomplete");
      if (Object.values(result.tables).some((table) => !["fresh", "stale", "missing", "probe_failed"].includes(table.status))) throw new Error("freshness_status_invalid");
      if (Object.entries(manifest.dimension_targets ?? {}).some(([table, target]) => !dimensionSnapshotStatusValid(result.tables[table], table, target))) throw new Error("freshness_dimension_snapshot_invalid");
      const [pointers] = await conn.query<RowDataPacket[]>("SELECT version FROM freshness_pointer WHERE singleton = 1 FOR UPDATE");
      const current = Number(pointers[0]?.version ?? 0);
      if (current >= version) {
        await conn.rollback();
        return "superseded";
      }
      const [times] = await conn.query<RowDataPacket[]>("SELECT DATE_FORMAT(UTC_TIMESTAMP(3), '%Y-%m-%dT%H:%i:%s.%fZ') AS now_utc");
      const publication: MysqlFreshnessPublication = { ...result, publication_id: String(batch.publication_id), version, published_at: String(times[0]?.now_utc), manifest };
      await conn.query("UPDATE freshness_batches SET state = 'published', result_json = ?, published_at = UTC_TIMESTAMP(3) WHERE version = ? AND state = 'pending'", [JSON.stringify(publication), version]);
      await conn.query("UPDATE freshness_pointer SET version = ? WHERE singleton = 1", [version]);
      await conn.commit();
      return "published";
    } catch (error) {
      await conn.rollback().catch(() => undefined);
      throw error;
    } finally {
      conn.release();
    }
  }

  async current(): Promise<MysqlFreshnessPublication | null> {
    const [rows] = await this.deadline(this.pool.query<RowDataPacket[]>("SELECT b.result_json FROM freshness_pointer p JOIN freshness_batches b ON b.version = p.version AND b.state = 'published' WHERE p.singleton = 1"));
    return rows[0] ? JSON.parse(String(rows[0].result_json)) as MysqlFreshnessPublication : null;
  }

  async get(version: number): Promise<MysqlFreshnessPublication | null> {
    const [rows] = await this.deadline(this.pool.query<RowDataPacket[]>("SELECT result_json FROM freshness_batches WHERE version = ? AND state = 'published'", [version]));
    return rows[0] ? JSON.parse(String(rows[0].result_json)) as MysqlFreshnessPublication : null;
  }

  async close(): Promise<void> { await this.deadline(this.pool.end()); }

  private deadline<T>(operation: Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("freshness_state_outcome_unknown")), this.timeoutMs);
      operation.then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
    });
  }
}
