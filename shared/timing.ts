import type { EvalKind } from './types.js';

export interface Spread {
  p50: number;
  p95: number;
}

/** Nearest-rank percentile of `values` (any order; not mutated), p in (0, 100]. Null when empty. */
export function percentile(values: readonly number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)];
}

export function spread(values: readonly number[]): Spread | null {
  const p50 = percentile(values, 50);
  return p50 === null ? null : { p50, p95: percentile(values, 95)! };
}

export interface JobSample {
  ms: number;
  depth: number;
  kind: EvalKind;
}

export interface JobTiming {
  jobs: number; // Complete evals in the window
  provisional: number; // Provisional evals in the window (pre-empted Backfill Jobs)
  ms: Spread | null; // job time of the Complete ones
  depth: Spread | null; // depth reached by the Complete ones
}

/** Spreads cover Complete Jobs only: a Provisional Job's time is just how soon it was pre-empted. */
export function jobTiming(samples: readonly JobSample[]): JobTiming {
  const complete = samples.filter((s) => s.kind === 'complete');
  return {
    jobs: complete.length,
    provisional: samples.length - complete.length,
    ms: spread(complete.map((s) => s.ms)),
    depth: spread(complete.map((s) => s.depth)),
  };
}
