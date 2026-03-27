/**
 * GenomeBrowser.tsx — Embedded JBrowse 2 linear genome view.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import {
  createViewState,
  JBrowseLinearGenomeView,
} from "@jbrowse/react-linear-genome-view";
import type {
  GenomicFeature,
  SequenceRegion,
} from "../workers/db.worker";

interface GenomeBrowserProps {
  sequenceRegions: SequenceRegion[];
  getFeaturesInRegion: (
    seqid: string,
    start: number,
    end: number,
    limit?: number
  ) => Promise<GenomicFeature[]>;
  selectedFeature: GenomicFeature | null;
}

function toJBrowseCoords(start: number, end: number) {
  return { start: start - 1, end };
}

function strandToInt(s: string): number {
  if (s === "+") return 1;
  if (s === "-") return -1;
  return 0;
}

function makeAssembly(regions: SequenceRegion[]) {
  return {
    name: "genome",
    aliases: ["sampleGenome"],
    sequence: {
      type: "ReferenceSequenceTrack" as const,
      trackId: "genome-refseq",
      adapter: {
        type: "FromConfigSequenceAdapter" as const,
        features: regions.map((r) => ({
          refName: r.seqid,
          uniqueId: r.seqid,
          start: 0,
          end: r.end,
        })),
      },
    },
  };
}

function makeTrackFeatures(features: GenomicFeature[]) {
  return features.map((f) => {
    const { start, end } = toJBrowseCoords(f.start, f.end);
    return {
      uniqueId: `feat-${f.id}`,
      refName: f.seqid,
      start,
      end,
      name: f.name || f.feature_id,
      type: f.feature_type,
      strand: strandToInt(f.strand),
      description: f.description,
      biotype: f.biotype,
    };
  });
}

export default function GenomeBrowser({
  sequenceRegions,
  getFeaturesInRegion,
  selectedFeature,
}: GenomeBrowserProps) {
  const [viewState, setViewState] = useState<any>(null);
  const [windowFeatures, setWindowFeatures] = useState<GenomicFeature[]>([]);
  const [currentLoc, setCurrentLoc] = useState<string | undefined>(undefined);
  const initialised = useRef(false);

  const assembly = useMemo(() => {
    if (sequenceRegions.length === 0) return null;
    return makeAssembly(sequenceRegions);
  }, [sequenceRegions]);

  useEffect(() => {
    if (initialised.current || sequenceRegions.length === 0) {
      return;
    }

    let cancelled = false;

    const boot = async () => {
      const first = sequenceRegions[0];
      const start = 1;
      const end = Math.min(100_000, first.end);
      const features = await getFeaturesInRegion(first.seqid, start, end, 10_000);

      if (cancelled) return;
      setWindowFeatures(features);
      setCurrentLoc(`${first.seqid}:${start}..${end}`);
      initialised.current = true;
    };

    void boot();

    return () => {
      cancelled = true;
    };
  }, [sequenceRegions, getFeaturesInRegion]);

  useEffect(() => {
    if (!assembly || !currentLoc) {
      return;
    }

    const state = createViewState({
      assembly,
      tracks: [
        {
          type: "FeatureTrack",
          trackId: "genomic-features",
          name: "Genomic Features",
          assemblyNames: ["genome"],
          adapter: {
            type: "FromConfigAdapter",
            features: makeTrackFeatures(windowFeatures),
          },
        },
      ],
      location: currentLoc,
    });

    try {
      state.session.view.showTrack("genomic-features");
    } catch {}

    setViewState(state);
  }, [assembly, windowFeatures, currentLoc]);

  useEffect(() => {
    if (!selectedFeature) return;

    let cancelled = false;

    const loadAndNavigate = async () => {
      const padding = Math.max(
        200,
        Math.round((selectedFeature.end - selectedFeature.start) * 0.2)
      );
      const start = Math.max(1, selectedFeature.start - padding);
      const end = selectedFeature.end + padding;
      const loc = `${selectedFeature.seqid}:${start}..${end}`;

      try {
        const features = await getFeaturesInRegion(
          selectedFeature.seqid,
          start,
          end,
          10_000
        );
        if (cancelled) return;
        setWindowFeatures(features);
        setCurrentLoc(loc);
      } catch (err) {
        console.warn("[GenomeBrowser] Region fetch failed:", err);
      }
    };

    void loadAndNavigate();

    return () => {
      cancelled = true;
    };
  }, [selectedFeature, getFeaturesInRegion]);

  if (sequenceRegions.length === 0) {
    return null;
  }

  return (
    <section className="min-w-0 w-full lg:basis-[62%] lg:max-w-[62%] border border-[#2a2d3a] rounded-lg p-4 bg-[#1a1d27]">
      <h2 className="text-lg font-semibold mb-3 text-[#e1e4ed]">
        Genome Browser
      </h2>
      {viewState ? (
        <div className="w-full min-h-[460px] h-[62vh] max-h-[760px] overflow-auto rounded-md border border-[#2a2d3a] bg-[#10141f]">
          <JBrowseLinearGenomeView viewState={viewState} />
        </div>
      ) : (
        <p className="text-[#8b8fa3] text-sm py-4">
          Preparing genome browser…
        </p>
      )}
    </section>
  );
}