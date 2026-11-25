import type { Score } from '$shared/accuracy';

/** White POV: "+0.35", "-1.20", "#3", "#-2". */
export const formatScore = (s: Score): string =>
  'mate' in s ? `#${s.mate}` : `${s.cp > 0 ? '+' : ''}${(s.cp / 100).toFixed(2)}`;

/** ms → "1:05:09" / "4:07". */
export function formatClock(ms: number | null): string {
  if (ms === null) return '–';
  const t = Math.max(0, Math.round(ms / 1000));
  const [h, m, s] = [Math.floor(t / 3600), Math.floor(t / 60) % 60, t % 60];
  const ss = String(s).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}
