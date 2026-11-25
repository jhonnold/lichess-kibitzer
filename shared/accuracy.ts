// Lichess win%, accuracy and move marks, ported from lila (master, fetched 2026-11-25):
// - scalachess core/src/main/scala/eval.scala (WinPercent, Eval.Cp.CEILING)
// - lila modules/analyse/src/main/AccuracyPercent.scala (fromWinPercents, gameAccuracy)
// - lila modules/tree/src/main/Advice.scala (CpAdvice, MateAdvice)
// - scalalib lila/src/main/scala/Maths.scala (weightedMean, harmonicMean, standardDeviation)

export type Color = 'white' | 'black';

/** Eval from White's side: centipawns, or moves to mate (> 0: White mates). Never mate 0: a finished game has no eval. */
export type Score = { cp: number } | { mate: number };

export type Mark = 'inaccuracy' | 'mistake' | 'blunder';

const CP_CEILING = 1000;
const MULTIPLIER = -0.00368208; // https://github.com/lichess-org/lila/pull/11148

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const other = (c: Color): Color => (c === 'white' ? 'black' : 'white');

/** White's winning chances in [-1, 1]. Not ceiled: Advice uses raw cp. */
function winningChances(cp: number): number {
  return clamp(2 / (1 + Math.exp(MULTIPLIER * cp)) - 1, -1, 1);
}

/** White's win% in [0, 100]. Cp is ceiled at ±1000; mate counts as ±1000. */
export function winPercent(s: Score): number {
  const cp = 'mate' in s ? (s.mate > 0 ? CP_CEILING : -CP_CEILING) : clamp(s.cp, -CP_CEILING, CP_CEILING);
  return 50 + 50 * winningChances(cp);
}

/** Win% for `c`, from White's win%. */
const pov = (whiteWinPercent: number, c: Color) => (c === 'white' ? whiteWinPercent : 100 - whiteWinPercent);

/** AccuracyPercent.fromWinPercents: both win% from the mover's side. */
function accuracyFromWinPercents(before: number, after: number): number {
  if (after >= before) return 100;
  const raw = 103.1668100711649 * Math.exp(-0.04354415386753951 * (before - after)) + -3.166924740191411;
  return clamp(raw + 1, 0, 100); // +1: lila's "uncertainty bonus"
}

/** Accuracy % of one move by `mover`, from the evals before and after it. */
export function moveAccuracy(before: Score, after: Score, mover: Color): number {
  return accuracyFromWinPercents(pov(winPercent(before), mover), pov(winPercent(after), mover));
}

/** Scala's `sliding(n)`: a list shorter than n gives one window. */
function sliding<T>(xs: T[], n: number): T[][] {
  if (xs.length <= n) return xs.length ? [xs] : [];
  return xs.slice(0, xs.length - n + 1).map((_, i) => xs.slice(i, i + n));
}

function stdev(xs: number[]): number {
  const mean = xs.reduce((s, x) => s + x, 0) / xs.length;
  return Math.sqrt(xs.reduce((s, x) => s + (x - mean) ** 2, 0) / xs.length); // population variance
}

/** Mean of the weighted mean and the harmonic mean, as lila's colorAccuracy. */
function combine(moves: [accuracy: number, weight: number][]): number | null {
  if (!moves.length) return null;
  const weighted = moves.reduce((s, [a, w]) => s + a * w, 0) / moves.reduce((s, [, w]) => s + w, 0);
  const harmonic = moves.length / moves.reduce((s, [a]) => s + 1 / Math.max(1, a), 0);
  return (weighted + harmonic) / 2;
}

/**
 * Game accuracy % per colour (AccuracyPercent.gameAccuracy), unrounded; null when a colour has no scored move.
 * evals[i] is the eval of the i-th position; `firstMover` moves from evals[0]. A null eval skips both moves
 * touching it, and every move whose volatility window contains it.
 */
export function gameAccuracy(evals: (Score | null)[], firstMover: Color): Record<Color, number | null> {
  const wps = evals.map((s) => (s ? winPercent(s) : null));
  const size = clamp(Math.trunc((wps.length - 1) / 10), 2, 8);
  // One window per move: the first size - 2 moves reuse the opening window.
  const windows = [
    ...Array<(number | null)[]>(Math.max(0, Math.min(size, wps.length) - 2)).fill(wps.slice(0, size)),
    ...sliding(wps, size),
  ];
  const weights = windows.map((w) => (w.every((x) => x !== null) ? clamp(stdev(w as number[]), 0.5, 12) : null));
  const scored: Record<Color, [number, number][]> = { white: [], black: [] };
  for (let i = 0; i + 1 < wps.length; i++) {
    const [before, after, weight] = [wps[i], wps[i + 1], weights[i]];
    if (before === null || after === null || weight === null) continue;
    const mover = i % 2 === 0 ? firstMover : other(firstMover);
    scored[mover].push([accuracyFromWinPercents(pov(before, mover), pov(after, mover)), weight]);
  }
  return { white: combine(scored.white), black: combine(scored.black) };
}

const CP_MARKS: [number, Mark][] = [
  [0.3, 'blunder'],
  [0.2, 'mistake'],
  [0.1, 'inaccuracy'],
];

/**
 * Mark for one move by `mover` (lila Advice: CpAdvice when both evals are cp, else MateAdvice).
 * lila only judges moves that differ from the engine's best move; the caller skips those.
 */
export function moveMark(before: Score, after: Score, mover: Color): Mark | null {
  const sign = mover === 'white' ? 1 : -1;
  if ('cp' in before && 'cp' in after) {
    const loss = sign * (winningChances(before.cp) - winningChances(after.cp));
    return CP_MARKS.find(([threshold]) => threshold <= loss)?.[1] ?? null;
  }
  // From the mover's side: mate > 0 means the mover mates; cp is 0 when the eval is a mate.
  const prevMate = 'mate' in before ? sign * before.mate : null;
  const nextMate = 'mate' in after ? sign * after.mate : null;
  const prevCp = 'cp' in before ? sign * before.cp : 0;
  const nextCp = 'cp' in after ? sign * after.cp : 0;
  if (prevMate === null && nextMate !== null && nextMate < 0) {
    // MateCreated
    return prevCp < -999 ? 'inaccuracy' : prevCp < -700 ? 'mistake' : 'blunder';
  }
  if (prevMate !== null && prevMate > 0 && (nextMate === null || nextMate < 0)) {
    // MateLost
    return nextCp > 999 ? 'inaccuracy' : nextCp > 700 ? 'mistake' : 'blunder';
  }
  return null; // MateDelayed, or no mate sequence
}
