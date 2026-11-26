/** Seconds typed in the Admin form → ms; null when not a positive number. */
export function jobTimeMs(seconds: string): number | null {
  const ms = Math.round(Number(seconds) * 1000);
  return seconds.trim() !== '' && Number.isFinite(ms) && ms > 0 ? ms : null;
}

export const formatJobTime = (ms: number | null): string =>
  ms === null ? 'unset — the Queue is idle' : `${ms / 1000} s`;
