import SearchBar from "./components/SearchBar";
import { useDbSearch } from "./hooks/useDbSearch";

export default function App() {
  const {
    results,
    loading,
    searching,
    status,
    error,
    elapsed,
    search,
  } = useDbSearch();

  return (
    <main className="min-h-screen w-full max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-8 flex flex-col">
      <div className="w-full flex-1 min-h-0 flex flex-col gap-6">
        <SearchBar
          results={results}
          loading={loading}
          searching={searching}
          status={status}
          error={error}
          elapsed={elapsed}
          search={search}
        />
      </div>

      <footer className="mt-12 pt-8 text-center text-[0.78rem] text-[#8b8fa3] w-full border-t border-[#2a2d3a]">
        <p>
          Genomic Search POC - Local-first SQLite WASM + FTS5 ·{" "}
          <a
            href="https://github.com/aliarif2050/Genomic_Search_Poc"
            target="_blank"
            rel="noreferrer"
            className="text-[#58a6ff] hover:underline"
          >
            Source Code
          </a>
        </p>
      </footer>
    </main>
  );
}