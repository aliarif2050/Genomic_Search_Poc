import { useState } from "react";
import SearchBar from "./components/SearchBar";
import GenomeBrowser from "./components/GenomeBrowser";
import { useDbSearch, type GenomicFeature } from "./hooks/useDbSearch";

export default function App() {
  const {
    results,
    loading,
    searching,
    status,
    error,
    elapsed,
    search,
    getFeaturesInRegion,
    sequenceRegions,
  } = useDbSearch();
  const [selectedFeature, setSelectedFeature] =
    useState<GenomicFeature | null>(null);

  return (
    <main className="min-h-screen w-full max-w-400 mx-auto px-4 sm:px-6 lg:px-10 py-6 flex flex-col">
      <div className="w-full flex-1 min-h-0 flex flex-col lg:flex-row gap-6 items-start">
      <SearchBar
        onFeatureClick={setSelectedFeature}
        results={results}
        loading={loading}
        searching={searching}
        status={status}
        error={error}
        elapsed={elapsed}
        search={search}
      />

      <GenomeBrowser
        sequenceRegions={sequenceRegions}
        getFeaturesInRegion={getFeaturesInRegion}
        selectedFeature={selectedFeature}
      />
      </div>

      <footer className="mt-12 pt-8 text-center text-[0.78rem] text-[#8b8fa3] w-full">
      <p>
        Genomic Search POC - Local-first SQLite WASM + FTS5 ·{" "}
        <a
        href="https://github.com/nicholasgasior/gff3-parser"
        target="_blank"
        rel="noreferrer"
        className="text-[#58a6ff] hover:underline"
        >
        Data: Ensembl sample GFF3
        </a>
      </p>
      </footer>
    </main>
  );
}