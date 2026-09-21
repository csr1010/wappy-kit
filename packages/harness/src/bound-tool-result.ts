export interface BoundedToolResult {
  truncated: boolean;
  /** Size of the ORIGINAL data (before any bounding), in bytes (JSON-serialized length). */
  totalBytes: number;
  /** The (possibly paged/truncated) data actually safe to hand to the model. */
  shown: unknown;
  /** Human-readable note on what was cut, e.g. "showing 10 of 500 items". Present only when truncated. */
  hint?: string;
}

export interface BoundToolResultOptions {
  maxBytes: number;
  maxArrayItems: number;
}

function byteSize(value: unknown): number {
  return typeof value === "string" ? value.length : JSON.stringify(value)?.length ?? 0;
}

/**
 * Bounds a tool's result before it reaches the model (§10 "prompt/token overflow", T6.6): arrays are
 * paged to `maxArrayItems` (and further trimmed if still over `maxBytes`); strings are truncated to
 * `maxBytes`; anything else that's oversized is JSON-stringified and truncated the same way. Never
 * passes raw megabytes through untouched.
 *
 * Deliberately NOT wired into any real call path yet: `AgentDeps.invokeTools` (agent.ts) returns
 * pre-stringified `string[]` findings, not the raw tool-result objects this function expects to
 * bound. Real tool execution — where raw results actually exist to bound — lands in M7's
 * tools-openapi engine; that's the natural place to wire this in, matching M5/M6's established
 * precedent of leaving a built-and-tested piece unwired until its real caller exists (e.g.
 * createVercelModel's tool loop, Memory.recall not yet the default RAG implementation).
 */
export function boundToolResult(data: unknown, opts: BoundToolResultOptions): BoundedToolResult {
  const totalBytes = byteSize(data);

  if (Array.isArray(data)) {
    let shown = data.slice(0, opts.maxArrayItems);
    while (shown.length > 0 && byteSize(shown) > opts.maxBytes) shown = shown.slice(0, -1);
    const truncated = shown.length < data.length;
    return truncated
      ? { truncated, totalBytes, shown, hint: `showing ${shown.length} of ${data.length} items` }
      : { truncated: false, totalBytes, shown };
  }

  if (typeof data === "string") {
    if (data.length <= opts.maxBytes) return { truncated: false, totalBytes, shown: data };
    return { truncated: true, totalBytes, shown: data.slice(0, opts.maxBytes), hint: `truncated to ${opts.maxBytes} of ${totalBytes} bytes` };
  }

  if (totalBytes <= opts.maxBytes) return { truncated: false, totalBytes, shown: data };
  // Reaching here means JSON.stringify(data) produced a real string longer than maxBytes (totalBytes
  // is derived from that same string, via byteSize — a value where stringify returns undefined, e.g.
  // a bare `undefined`, always has totalBytes 0 and returns above instead).
  const serialized = JSON.stringify(data)!;
  return { truncated: true, totalBytes, shown: serialized.slice(0, opts.maxBytes), hint: `truncated to ${opts.maxBytes} of ${totalBytes} bytes` };
}
