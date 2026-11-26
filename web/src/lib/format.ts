export { formatScore } from '$shared/viewer';

/** ms → "1:05:09" / "4:07". */
export function formatClock(ms: number | null): string {
  if (ms === null) return '–';
  const t = Math.max(0, Math.round(ms / 1000));
  const [h, m, s] = [Math.floor(t / 3600), Math.floor(t / 60) % 60, t % 60];
  const ss = String(s).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

export const formatNps = (n: number | null): string =>
  n === null ? '–' : n >= 1e6 ? `${(n / 1e6).toFixed(1)} Mn/s` : `${Math.round(n / 1e3)} kn/s`;

/** SAN line played from position `ply` (even = White to move): "21. Nf3 Nc6 22. Bb5", "21... Nc6 22. Bb5". */
export const formatLine = (ply: number, san: string[]): string =>
  san
    .map((m, i) => {
      const [p, n] = [ply + i, Math.floor((ply + i) / 2) + 1];
      return p % 2 === 0 ? `${n}. ${m}` : i === 0 ? `${n}... ${m}` : m;
    })
    .join(' ');
