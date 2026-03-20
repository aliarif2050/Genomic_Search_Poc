/**
 * useDbSearch.ts — React hook that manages the lifecycle of the
 * SQLite Web Worker and exposes a simple search interface.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import * as Comlink from "comlink";
import type { WorkerApi, GenomicFeature, SearchResult, SequenceRegion } from "../workers/db.worker";

// Re-export types so consumers don't need to import from the worker file
export type { GenomicFeature, SearchResult, SequenceRegion };

export interface UseDbSearchReturn {
  /** Current search results */
  results: GenomicFeature[];
  /** Whether the WASM DB is still loading */
  loading: boolean;
  /** Whether a search query is in-flight */
  searching: boolean;
  /** Informational status message */
  status: string;
  /** Error message, if any */
  error: string | null;
  /** Time the last query took (ms) */
  elapsed: number;
  /** Trigger a search. Debounced automatically in the component layer. */
  search: (query: string) => Promise<void>;
  /** Sequence regions (chromosomes / scaffolds) discovered from the DB */
  sequenceRegions: SequenceRegion[];
  /** All features loaded from the DB (for JBrowse display) */
  allFeatures: GenomicFeature[];
}

const DB_URL = "/genomics.db";

export function useDbSearch(): UseDbSearchReturn {
  const workerRef = useRef<Comlink.Remote<WorkerApi> | null>(null);
  const rawWorkerRef = useRef<Worker | null>(null);

  const [results, setResults] = useState<GenomicFeature[]>([]);
  const [loading, setLoading] = useState(true);
  const [searching, setSearching] = useState(false);
  const [status, setStatus] = useState("Initialising…");
  const [error, setError] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [sequenceRegions, setSequenceRegions] = useState<SequenceRegion[]>([]);
  const [allFeatures, setAllFeatures] = useState<GenomicFeature[]>([]);

  // ---- Boot: fetch DB + init worker ----
  useEffect(() => {
    let cancelled = false;

    async function boot() {
      try {
        // 1. Spin up the Web Worker
        const raw = new Worker(
          new URL("../workers/db.worker.ts", import.meta.url),
          { type: "module" }
        );
        rawWorkerRef.current = raw;
        const proxy = Comlink.wrap<WorkerApi>(raw);
        workerRef.current = proxy;

        // 2. Let the worker fetch the .db file using HTTP Range requests
        //    (falls back to a single GET if the server doesn't support ranges)
        setStatus("Downloading database (HTTP Range requests)…");
        const msg = await proxy.initFromUrl(DB_URL);

        if (!cancelled) {
          setStatus(msg);

          // 3. Load metadata for the genome browser
          const regions = await proxy.getSequenceRegions();
          const features = await proxy.getAllFeatures();
          setSequenceRegions(regions);
          setAllFeatures(features);

          setLoading(false);
        }
      } catch (err: any) {
        if (!cancelled) {
          setError(err.message ?? String(err));
          setStatus("Failed to initialise database.");
          setLoading(false);
        }
      }
    }

    boot();

    return () => {
      cancelled = true;
      rawWorkerRef.current?.terminate();
    };
  }, []);

  // ---- Search ----
  const search = useCallback(async (query: string) => {
    if (!workerRef.current) return;
    if (!query.trim()) {
      setResults([]);
      setElapsed(0);
      return;
    }

    setSearching(true);
    try {
      const res = await workerRef.current.search(query);
      setResults(res.features);
      setElapsed(res.elapsed_ms);
      setError(null);
    } catch (err: any) {
      setError(err.message ?? String(err));
      setResults([]);
    } finally {
      setSearching(false);
    }
  }, []);

  return {
    results,
    loading,
    searching,
    status,
    error,
    elapsed,
    search,
    sequenceRegions,
    allFeatures,
  };
}
