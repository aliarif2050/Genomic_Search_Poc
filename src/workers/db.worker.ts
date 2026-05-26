/**
 * db.worker.ts — Web Worker that owns the SQLite WASM instance.
 *
 * Communication is handled via Comlink so the main thread can call
 * typed async methods instead of raw postMessage / onmessage.
 */

import * as Comlink from "comlink";
import { initSyncSQLite, createHttpBackend } from "sqlite-wasm-http";

// ---------------------------------------------------------------------------
// Types shared with the main thread
// ---------------------------------------------------------------------------

export interface GenomicFeature {
  id: number;
  feature_id: string;
  name: string;
  feature_type: string;
  seqid: string;
  start: number;
  end: number;
  strand: string;
  biotype: string;
  description: string;
  annotations: string;
}

export interface SearchResult {
  features: GenomicFeature[];
  elapsed_ms: number;
}

export interface SequenceRegion {
  seqid: string;
  start: number;
  end: number;
}

// ---------------------------------------------------------------------------
// Worker-internal state
// ---------------------------------------------------------------------------

let db: any = null; // oo1 (OO API #1) database handle
let sqlite3: any = null;
let httpBackend: any = null;

// ---------------------------------------------------------------------------
// Public API (exposed via Comlink)
// ---------------------------------------------------------------------------

const workerApi = {
  /**
   * Legacy method for array buffer initialization (disabled in VFS mode).
   */
  async init(arrayBuffer: ArrayBuffer): Promise<string> {
    throw new Error("init(ArrayBuffer) is disabled in on-demand VFS mode. Use initFromUrl(url) instead.");
  },

  /**
   * Full-text search against the FTS5 table.
   * Returns matching features ordered by FTS rank.
   */
  search(query: string,): SearchResult {
    if (!db) throw new Error("Database not initialised");

    const t0 = performance.now();

    // Sanitise: wrap bare terms so FTS5 doesn't choke on special chars
    const sanitised = query.replace(/[^a-zA-Z0-9*_ -]/g, "").trim();
    
    // Return early if the sanitised query is completely empty
    if (sanitised.length === 0) return { features: [], elapsed_ms: 0 };

    // Append '*' for prefix matching for all terms. Since we now have prefix indexes 1, 2, 3,
    // even single-character prefix searches are extremely fast!
    const ftsQuery = sanitised
      .split(/\s+/)
      .filter((t) => t.length > 0)
      .map((t) => `"${t}"*`)
      .join(" ");

    console.log(`[db.worker] search("${query}") → FTS query: ${ftsQuery}`);

    const sql = `
      SELECT f.id, f.feature_id, f.name, f.feature_type,
             f.seqid, f.start, f.end, f.strand, f.biotype, f.description, f.annotations
        FROM features_fts AS fts
        JOIN features     AS f ON f.id = fts.rowid
       WHERE features_fts MATCH ?
       ORDER BY fts.rank
       LIMIT 100;
    `;

    const rows: GenomicFeature[] = [];
    db.exec({
      sql,
      bind: [ftsQuery],
      rowMode: "object",
      callback: (row: GenomicFeature) => {
        rows.push({ ...row });
      },
    });

    console.log(`[db.worker] search found ${rows.length} results in ${(performance.now() - t0).toFixed(1)} ms`);
    return { features: rows, elapsed_ms: performance.now() - t0 };
  },

  /**
   * Retrieve all distinct feature types present in the database
   * (useful for building filter UI later).
   */
  getFeatureTypes(): string[] {
    if (!db) throw new Error("Database not initialised");
    const types: string[] = [];
    db.exec({
      sql: "SELECT DISTINCT feature_type FROM features ORDER BY feature_type",
      rowMode: "array",
      callback: (row: string[]) => types.push(row[0]),
    });
    return types;
  },

  /**
   * Initialise the database on-demand using HTTP VFS.
   * This uses HTTP Range requests to stream database blocks on-demand.
   */
  async initFromUrl(url: string): Promise<string> {
    console.log(`initFromUrl("${url}") — starting HTTP VFS initialization...`);
    const t0 = performance.now();

    try {
      // 1. Create the HTTP backend for remote database access
      httpBackend = createHttpBackend({
        maxPageSize: 8192,
        cacheSize: 4096, // 4MB cache size
        backendType: "sync",
      });

      console.log(`[db.worker] HTTP VFS backend created (type: ${httpBackend.type})`);

      // 2. Initialize synchronous SQLite w/ the HTTP backend
      sqlite3 = await initSyncSQLite({ http: httpBackend });
      console.log(`[db.worker] SQLite VFS initialized in ${(performance.now() - t0).toFixed(1)} ms`);

      const oo = sqlite3.oo1;

      // 3. Open the database using HTTP VFS
      db = new oo.DB({
        filename: "file:" + encodeURI(url),
        vfs: "http",
      });

      console.log(`[db.worker] Database opened via HTTP VFS in ${(performance.now() - t0).toFixed(1)} ms`);

      // 4. Quick sanity check: count indexed features
      const count = db.selectValue("SELECT count(*) FROM features");
      console.log(`[db.worker] Database ready — ${count} features indexed`);

      return `Database loaded via on-demand HTTP VFS (type: ${httpBackend.type}) – ${count} features indexed.`;
    } catch (err: any) {
      console.error(`[db.worker] Failed to initialize HTTP VFS:`, err);
      throw err;
    }
  },
};

export type WorkerApi = typeof workerApi;

Comlink.expose(workerApi);
