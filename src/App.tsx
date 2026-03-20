import { useState } from "react";
import SearchBar from "./components/SearchBar";
import GenomeBrowser from "./components/GenomeBrowser";
import { useDbSearch, type GenomicFeature } from "./hooks/useDbSearch";
import "./App.css";

export default function App() {
  const { sequenceRegions, allFeatures } = useDbSearch();
  const [selectedFeature, setSelectedFeature] =
    useState<GenomicFeature | null>(null);

  return (
    // 1. Make the main wrapper a vertical flexbox that takes up at least the full screen height
    <main className="h-screen mx-auto p-6 flex flex-col overflow-hidden">
      
      {/* 2. Wrap the two components in a container that puts them side-by-side (row) */}
      <div className="pl-4 flex flex-col lg:flex-row gap-8 w-full flex-1 min-h-0">
        
        {/* Left Side: Search Bar */}
        <SearchBar onFeatureClick={setSelectedFeature} />

        {/* Right Side: Genome Browser */}
        <GenomeBrowser
          sequenceRegions={sequenceRegions}
          allFeatures={allFeatures}
          selectedFeature={selectedFeature}
        />
      </div>

      {/* 3. The footer sits below the side-by-side container */}
      <footer className="mt-12 pt-8 text-center text-[0.78rem] text-[#8b8fa3] w-full">
        <p>
          Genomic Search POC — Local-first SQLite WASM + FTS5 ·{" "}
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