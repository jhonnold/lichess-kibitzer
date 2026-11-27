import type { Eval, PassesMs } from './types.js';

/** The deep Pass: never queued automatically, only for an Admin's deep analysis request, and run only while no Event
 *  is live. */
export const DEEP_PASS = 2;

/** The automatic Pass a ply's next search is for; null = none left. Pass 0 is reached by any Complete eval (one
 *  recorded before Passes too); Pass k ≥ 1 by a Complete eval that searched at least its time. The deep Pass is never
 *  next: it is on demand only. Ply 0 (the start position) gets Pass 0 only. Unset passes: Pass 0 only (the Queue idles
 *  anyway). */
export function nextPass(e: Eval | null | undefined, ply: number, passes: PassesMs | null): number | null {
  if (e?.kind !== 'complete') return 0;
  if (ply === 0 || !passes) return null;
  for (let k = 1; k < DEEP_PASS; k++) {
    const ms = passes[k];
    if (ms !== null && (e.ms ?? 0) < ms) return k;
  }
  return null;
}

/** The highest Pass a Job may run at: DEEP_PASS while no Event is live, else the one below. */
export const maxPass = (live: boolean): number => (live ? DEEP_PASS - 1 : DEEP_PASS);

/** Null when valid, else why: slot 0 a positive integer, slots 1-2 null or one, non-null values strictly ascending. */
export function passesError(x: unknown, maxMs: number): string | null {
  if (!Array.isArray(x) || x.length !== 3) return 'expected 3 slots';
  const ok = (v: unknown) => Number.isInteger(v) && (v as number) > 0 && (v as number) <= maxMs;
  if (!ok(x[0])) return `Pass 1 must be 1-${maxMs} ms`;
  if (!x.slice(1).every((v) => v === null || ok(v))) return `Passes 2-3 must be off or 1-${maxMs} ms`;
  const on = x.filter((v) => v !== null) as number[];
  return on.every((v, i) => i === 0 || v > on[i - 1]) ? null : 'Passes must be strictly ascending';
}
