/**
 * db.worker.ts — Web Worker that owns the SQLite WASM instance.
 *
 * Communication is handled via Comlink so the main thread can call
 * typed async methods instead of raw postMessage / onmessage.
 */

import * as Comlink from "comlink";

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

// ---------------------------------------------------------------------------
// Public API (exposed via Comlink)
// ---------------------------------------------------------------------------

const workerApi = {
  /**
   * Initialise the WASM SQLite engine and open the database from an
   * ArrayBuffer that was fetched on the main thread.
   */
  async init(arrayBuffer: ArrayBuffer): Promise<string> {
    // Dynamically import sqlite3 WASM init function
    const { default: sqlite3InitModule } = await import(
      // @ts-ignore — resolved by Vite at bundle-time
      "@sqlite.org/sqlite-wasm"
    );

    sqlite3 = await (sqlite3InitModule as any)({
      print: console.log,
      printErr: console.error,
    });

    const oo = sqlite3.oo1;
    const capi = sqlite3.capi;

    // Deserialize the ArrayBuffer into an in-memory database
    const bytes = new Uint8Array(arrayBuffer);

    // Create an in-memory database and deserialize the bytes into it
    db = new oo.DB(":memory:", "c");
    const rc = capi.sqlite3_deserialize(
      db.pointer,
      "main",
      sqlite3.wasm.allocFromTypedArray(bytes),
      bytes.byteLength,
      bytes.byteLength,
      capi.SQLITE_DESERIALIZE_FREEONCLOSE |
        capi.SQLITE_DESERIALIZE_RESIZEABLE
    );

    if (rc !== 0) {
      throw new Error(`sqlite3_deserialize failed with rc=${rc}`);
    }

    // Quick sanity check
    const count = db.selectValue("SELECT count(*) FROM features");
    return `Database loaded – ${count} features indexed.`;
  },

  /**
   * Full-text search against the FTS5 table.
   * Returns matching features ordered by FTS rank.
   */
  search(query: string, limit = 60): SearchResult {
    if (!db) throw new Error("Database not initialised");

    const t0 = performance.now();

    // Sanitise: wrap bare terms so FTS5 doesn't choke on special chars
    const sanitised = query.replace(/[^a-zA-Z0-9*_ -]/g, "").trim();
    if (!sanitised) return { features: [], elapsed_ms: 0 };

    // Append '*' for prefix matching so partial words still hit
    const ftsQuery = sanitised
      .split(/\s+/)
      .map((t) => `"${t}"*`)
      .join(" ");

    const sql = `
      SELECT f.id, f.feature_id, f.name, f.feature_type,
             f.seqid, f.start, f.end, f.strand, f.biotype, f.description
        FROM features_fts AS fts
        JOIN features     AS f ON f.id = fts.rowid
       WHERE features_fts MATCH ?
       ORDER BY fts.rank
       LIMIT ?;
    `;

    const rows: GenomicFeature[] = [];
    db.exec({
      sql,
      bind: [ftsQuery, limit],
      rowMode: "object",
      callback: (row: GenomicFeature) => {
        rows.push({ ...row });
      },
    });

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
   * Initialise the database by fetching the .db file from a URL,
   * using HTTP Range requests when the server supports them.
   * Falls back to a single GET if Range is unsupported.
   */
  async initFromUrl(url: string): Promise<string> {
    const { loadWithRangeRequests } = await import("./httpRangeLoader");

    const result = await loadWithRangeRequests(url, {
      chunkSize: 256 * 1024,
    });

    const msg = await workerApi.init(result.buffer);

    const method = result.usedRangeRequests
      ? `Loaded via ${result.chunksLoaded} HTTP Range request(s) (${(result.totalBytes / 1024).toFixed(0)} KB)`
      : `Loaded via single request (${(result.totalBytes / 1024).toFixed(0)} KB)`;

    return `${msg} ${method}.`;
  },

  /**
   * Return the distinct sequence regions (chromosomes / scaffolds)
   * with their coordinate extents, derived from feature boundaries.
   */
  getSequenceRegions(): SequenceRegion[] {
    if (!db) throw new Error("Database not initialised");
    const regions: SequenceRegion[] = [];
    db.exec({
      sql: `SELECT seqid, MIN(start) AS start, MAX(end) AS end
              FROM features GROUP BY seqid ORDER BY seqid`,
      rowMode: "object",
      callback: (row: any) =>
        regions.push({ seqid: row.seqid, start: row.start, end: row.end }),
    });
    return regions;
  },

  /**
   * Retrieve all features (up to `limit`) for bulk display, e.g. in
   * a genome browser track.
   */
  getAllFeatures(limit = 10000): GenomicFeature[] {
    if (!db) throw new Error("Database not initialised");
    const features: GenomicFeature[] = [];
    db.exec({
      sql: `SELECT id, feature_id, name, feature_type, seqid, start, end,
                    strand, biotype, description
               FROM features ORDER BY seqid, start LIMIT ?`,
      bind: [limit],
      rowMode: "object",
      callback: (row: GenomicFeature) => features.push({ ...row }),
    });
    return features;
  },
};

export type WorkerApi = typeof workerApi;

Comlink.expose(workerApi);
