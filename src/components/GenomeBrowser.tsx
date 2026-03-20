/**
 * GenomeBrowser.tsx — Embedded JBrowse 2 linear genome view.
 */

import { useEffect, useRef, useState } from "react";
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
  allFeatures: GenomicFeature[];
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
  allFeatures,
  selectedFeature,
}: GenomeBrowserProps) {
  const [viewState, setViewState] = useState<any>(null);
  const initialised = useRef(false);

  useEffect(() => {
    if (
      initialised.current ||
      sequenceRegions.length === 0 ||
      allFeatures.length === 0
    ) {
      return;
    }

    const assembly = makeAssembly(sequenceRegions);
    const trackFeatures = makeTrackFeatures(allFeatures);

    const defaultLoc =
      sequenceRegions.length > 0
        ? `${sequenceRegions[0].seqid}:1..${Math.min(100_000, sequenceRegions[0].end)}`
        : undefined;

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
            features: trackFeatures,
          },
        },
      ],
      location: defaultLoc,
    });

    try {
      state.session.view.showTrack("genomic-features");
    } catch {}

    setViewState(state);
    initialised.current = true;
  }, [sequenceRegions, allFeatures]);

  useEffect(() => {
    if (!viewState || !selectedFeature) return;

    try {
      const padding = Math.max(
        200,
        Math.round((selectedFeature.end - selectedFeature.start) * 0.2)
      );
      const start = Math.max(1, selectedFeature.start - padding);
      const end = selectedFeature.end + padding;
      const loc = `${selectedFeature.seqid}:${start}..${end}`;
      viewState.session.view.navToLocString(loc);
    } catch (err) {
      console.warn("[GenomeBrowser] Navigation failed:", err);
    }
  }, [selectedFeature, viewState]);

  if (sequenceRegions.length === 0) {
    return null;
  }

  return (
    <section className="flex-6 min-w-0 h-fit sticky top-6 border border-[#2a2d3a] rounded-lg p-4 bg-[#1a1d27]">
      <h2 className="text-lg font-semibold mb-3 text-[#e1e4ed]">
        Genome Browser
      </h2>
      {viewState ? (
        <JBrowseLinearGenomeView viewState={viewState} />
      ) : (
        <p className="text-[#8b8fa3] text-sm py-4">
          Preparing genome browser…
        </p>
      )}
    </section>
  );
}