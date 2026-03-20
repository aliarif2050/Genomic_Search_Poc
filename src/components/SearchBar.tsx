/**
 * SearchBar.tsx — Main search UI component.
 *
 * Renders a search input with debounced querying plus a results table.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useDbSearch, type GenomicFeature } from "../hooks/useDbSearch";

const DEBOUNCE_MS = 250;

interface SearchBarProps {
  /** Called when the user clicks a feature row. */
  onFeatureClick?: (feature: GenomicFeature) => void;
}

// Helper for dynamic badge colors
function getBadgeClasses(type: string) {
  switch (type) {
    case "gene":
      return "bg-[#1a3a2a] text-[#3fb950]";
    case "mRNA":
      return "bg-[#1f3a5f] text-[#58a6ff]";
    case "exon":
      return "bg-[#2d2415] text-[#e3b341]";
    case "CDS":
      return "bg-[#2d1525] text-[#db61a2]";
    default:
      return "bg-[#222] text-[#aaa]";
  }
}

export default function SearchBar({ onFeatureClick }: SearchBarProps) {
  const { results, loading, searching, status, error, elapsed, search } =
    useDbSearch();

  const [query, setQuery] = useState("");
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Debounced search effect
  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const val = e.target.value;
      setQuery(val);

      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        search(val);
      }, DEBOUNCE_MS);
    },
    [search]
  );

  // Cleanup timer on unmount
  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  return (
    <div className="pl-4 min-w-0 w-full lg:basis-[38%] lg:max-w-[38%] flex flex-col">
      {/* Header */}
      <header>
        <h1 className="pl-2.5 text-3xl font-bold mb-1">🧬 Genomic Feature Search</h1>
        <p className="pl-2.5 text-md text-[#8b8fa3] mb-5">
          {loading ? "⏳ " : "✅ "}
          {status}
        </p>
      </header>

      {/* Search input */}
      <div className="px-4 border-b-2.5 relative mb-4">
        <input
          type="text"
          className="w-full px-4 py-3 text-base border border-[#2a2d3a] rounded-lg bg-[#1a1d27] text-[#e1e4ed] outline-none transition-colors duration-200 focus:border-[#58a6ff] focus:ring-[3px] focus:ring-[#1f3a5f] disabled:opacity-50 disabled:cursor-not-allowed"
          placeholder={
            loading
              ? "Loading database…"
              : "Search genes, transcripts, exons… (e.g. WASH7P, OR4F)"
          }
          value={query}
          onChange={handleChange}
          disabled={loading}
          autoFocus
        />
        {searching && (
          <span className="absolute right-[14px] top-1/2 -translate-y-1/2 w-[18px] h-[18px] border-2 border-[#2a2d3a] border-t-[#58a6ff] rounded-full animate-spin" />
        )}
      </div>

      {/* Error banner */}
      {error && (
        <div className="bg-[#2d1215] border border-[#f85149] rounded-md px-4 py-2.5 mb-4 text-sm text-[#f85149]">
          ⚠️ {error}
        </div>
      )}

      {/* Results meta */}
      {!loading && results.length > 0 && (
        <p className="text-[0.82rem] text-[#8b8fa3] mb-2">
          {results.length} result{results.length !== 1 ? "s" : ""} in{" "}
          {elapsed.toFixed(1)} ms
        </p>
      )}

      {/* Results table */}
      {results.length > 0 && (
        <div>
          <div className="overflow-x-auto max-h-[60vh] overflow-y-auto border border-[#2a2d3a] rounded-lg">
            <table className="w-full border-collapse text-[0.88rem]">
              <thead className="bg-[#1a1d27]">
                <tr>
                  {["Name", "Type", "Position", "Strand", "Biotype", "Description"].map(
                    (heading) => (
                      <th
                        key={heading}
                        className="sticky top-0 bg-[#1a1d27] z-10 text-left px-3 py-2.5 font-semibold text-[#8b8fa3] border-b-2 border-[#2a2d3a] whitespace-nowrap"
                      >
                        {heading}
                      </th>
                    )
                  )}
                </tr>
              </thead>
              <tbody>
                {results.map((f: GenomicFeature) => (
                  <tr
                    key={f.id}
                    onClick={() => onFeatureClick?.(f)}
                    className={`group transition-colors ${
                      onFeatureClick
                        ? "cursor-pointer hover:bg-[#1f3a5f]"
                        : "hover:bg-[#1a1d27]"
                    }`}
                  >
                    <td className="px-3 py-2 border-b border-[#2a2d3a] group-last:border-0 align-top font-mono text-[0.82rem]">
                      {f.name || f.feature_id}
                    </td>
                    <td className="px-3 py-2 border-b border-[#2a2d3a] group-last:border-0 align-top">
                      <span
                        className={`inline-block px-2 py-0.5 rounded text-[0.75rem] font-semibold uppercase tracking-[0.03em] ${getBadgeClasses(
                          f.feature_type
                        )}`}
                      >
                        {f.feature_type}
                      </span>
                    </td>
                    <td className="px-3 py-2 border-b border-[#2a2d3a] group-last:border-0 align-top font-mono text-[0.82rem]">
                      {f.seqid}:{f.start.toLocaleString()}-
                      {f.end.toLocaleString()}
                    </td>
                    <td className="px-3 py-2 border-b border-[#2a2d3a] group-last:border-0 align-top text-center">
                      {f.strand}
                    </td>
                    <td className="px-3 py-2 border-b border-[#2a2d3a] group-last:border-0 align-top">
                      {f.biotype}
                    </td>
                    <td className="px-3 py-2 border-b border-[#2a2d3a] group-last:border-0 align-top max-w-[280px] text-[#8b8fa3] text-[0.82rem] truncate">
                      {f.description}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Empty state */}
      {!loading && query && !searching && results.length === 0 && (
        <p className="text-center text-[#8b8fa3] mt-12 text-[0.95rem]">
          No features matched "{query}".
        </p>
      )}
    </div>
  );
}