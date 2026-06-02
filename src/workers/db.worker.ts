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

    // Replace underscores, hyphens, and other punctuation with spaces.
    // In FTS5 with detail=none, any punctuation-joined term (like BU_ATCC or gene-BU) is compiled
    // into an implicit phrase query, which causes a crash. Replacing punctuation with spaces
    // splits them into safe, high-speed boolean AND queries.
    const sanitised = query.replace(/[^a-zA-Z0-9*]/g, " ").trim();
    
    // Return early if the sanitised query is completely empty
    if (sanitised.length === 0) return { features: [], elapsed_ms: 0 };

    // Split into individual terms, clean up leading/trailing hyphens and wildcards to prevent FTS5 syntax errors,
    // and append '*' for prefix matching. Do NOT wrap in double quotes, as phrase queries are not supported
    // in FTS5 with detail=none.
    const ftsQuery = sanitised
      .split(/\s+/)
      .map((t) => t.replace(/^[-*]+|[-*]+$/g, "").trim())
      .filter((t) => t.length > 0)
      .map((t) => `${t}*`)
      .join(" ");

    console.log(`[db.worker] search("${query}") → FTS query: ${ftsQuery}`);

    const sql = `
      SELECT rowid AS id, feature_id, name, feature_type,
             seqid, start, end, strand, biotype, description, annotations
        FROM search_index
       WHERE search_index MATCH ?
       ORDER BY rank
       LIMIT 100;
    `;

    const rows = db.selectObjects(sql, [ftsQuery]) as GenomicFeature[];

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
      sql: "SELECT DISTINCT feature_type FROM search_index ORDER BY feature_type",
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

      // 4. Quick sanity check: retrieve the highest rowid from search_index.
      // This is an O(1) operation that avoids a full-table scan (SELECT count(*)) and prevents extra HTTP VFS range requests.
      const count = db.selectValue("SELECT max(rowid) FROM search_index") || 0;
      console.log(`[db.worker] Database ready — ~${count} features indexed`);

      return `Database loaded via on-demand HTTP VFS (type: ${httpBackend.type}) – ~${count} features indexed.`;
    } catch (err: any) {
      console.error(`[db.worker] Failed to initialize HTTP VFS:`, err);
      throw err;
    }
  },
};

export type WorkerApi = typeof workerApi;

Comlink.expose(workerApi);
