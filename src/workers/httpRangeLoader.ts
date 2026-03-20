/**
 * httpRangeLoader.ts — Fetch a remote file using HTTP Range requests.
 *
 * Demonstrates partial loading of a SQLite database by fetching chunks
 * on demand rather than downloading the entire file in one request.
 *
 * If the server supports `Accept-Ranges: bytes`, the file is downloaded
 * in configurable chunks.  Otherwise it falls back to a single GET.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RangeLoadProgress {
  phase: string;
  bytesLoaded: number;
  totalBytes: number;
  chunks: number;
}

export interface RangeLoadResult {
  /** The complete file buffer. */
  buffer: ArrayBuffer;
  /** Whether HTTP Range requests were actually used. */
  usedRangeRequests: boolean;
  /** Total size of the remote file (bytes). */
  totalBytes: number;
  /** Number of range-request chunks fetched. */
  chunksLoaded: number;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

const DEFAULT_CHUNK_SIZE = 256 * 1024; // 256 KB

/**
 * Probe the remote URL with a HEAD request to discover whether the server
 * advertises `Accept-Ranges: bytes` and what the file size is.
 */
async function probeRangeSupport(url: string): Promise<{
  supported: boolean;
  totalSize: number;
}> {
  const resp = await fetch(url, { method: "HEAD" });
  if (!resp.ok) throw new Error(`HEAD ${url} failed with status ${resp.status}`);

  const acceptRanges = resp.headers.get("Accept-Ranges");
  const contentLength = parseInt(
    resp.headers.get("Content-Length") ?? "0",
    10
  );

  return {
    supported: acceptRanges === "bytes" && contentLength > 0,
    totalSize: contentLength,
  };
}

/**
 * Fetch a specific byte range from the server.
 * Expects a `206 Partial Content` response.
 */
async function fetchRange(
  url: string,
  start: number,
  end: number
): Promise<ArrayBuffer> {
  const resp = await fetch(url, {
    headers: { Range: `bytes=${start}-${end}` },
  });

  // 206 = Partial Content (expected), 200 = server ignored Range header
  if (resp.status !== 206 && resp.status !== 200) {
    throw new Error(`Range request for ${url} failed: HTTP ${resp.status}`);
  }

  return resp.arrayBuffer();
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Load a remote file, preferring HTTP Range requests when supported.
 *
 * The file is fetched in `chunkSize`-byte pieces so the browser does not
 * need to buffer the entire payload in a single request.  Each chunk
 * fires the optional `onProgress` callback.
 *
 * If the server does not advertise `Accept-Ranges: bytes`, the loader
 * transparently falls back to a standard GET.
 */
export async function loadWithRangeRequests(
  url: string,
  options?: {
    chunkSize?: number;
    onProgress?: (progress: RangeLoadProgress) => void;
  }
): Promise<RangeLoadResult> {
  const chunkSize = options?.chunkSize ?? DEFAULT_CHUNK_SIZE;
  const onProgress = options?.onProgress;

  // ----- 1. Probe for Range support ----------------------------------------
  onProgress?.({
    phase: "Checking server capabilities…",
    bytesLoaded: 0,
    totalBytes: 0,
    chunks: 0,
  });

  let supported = false;
  let totalSize = 0;

  try {
    const probe = await probeRangeSupport(url);
    supported = probe.supported;
    totalSize = probe.totalSize;
  } catch {
    // HEAD failed or CORS blocked — fall through to plain GET
  }

  // ----- 2a. Fallback: plain GET -------------------------------------------
  if (!supported || totalSize === 0) {
    onProgress?.({
      phase: "Range requests not supported — downloading full file…",
      bytesLoaded: 0,
      totalBytes: totalSize,
      chunks: 0,
    });

    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`GET ${url} failed: HTTP ${resp.status}`);
    const buffer = await resp.arrayBuffer();

    return {
      buffer,
      usedRangeRequests: false,
      totalBytes: buffer.byteLength,
      chunksLoaded: 1,
    };
  }

  // ----- 2b. Chunked Range-request download --------------------------------
  const totalChunks = Math.ceil(totalSize / chunkSize);
  const result = new Uint8Array(totalSize);
  let bytesLoaded = 0;

  for (let i = 0; i < totalChunks; i++) {
    const start = i * chunkSize;
    const end = Math.min(start + chunkSize - 1, totalSize - 1);

    onProgress?.({
      phase: `Fetching chunk ${i + 1}/${totalChunks}…`,
      bytesLoaded,
      totalBytes: totalSize,
      chunks: i,
    });

    const chunk = await fetchRange(url, start, end);
    result.set(new Uint8Array(chunk), start);
    bytesLoaded += chunk.byteLength;
  }

  onProgress?.({
    phase: "Download complete",
    bytesLoaded: totalSize,
    totalBytes: totalSize,
    chunks: totalChunks,
  });

  return {
    buffer: result.buffer,
    usedRangeRequests: true,
    totalBytes: totalSize,
    chunksLoaded: totalChunks,
  };
}
