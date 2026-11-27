/**
 * Demo server for manual checks and screenshots: the real server with the fake engine and a synthesized Round built
 * from test/fixtures/lichess/round-stream.pgn. Never contacts lichess.org.
 *   npm run build && npm run demo -- [--port 18457] [--boards 10] [--top 8] [--passes 300,1500,6000] [--interval 1500]
 *                                    [--data DIR] [--password demo] [--rounds 1] [--swap-in 20] [--poll 2000]
 *                                    [--crash-board N] [--events 1]
 * --passes: the three Passes' search times in ms (Pass 0, free time, no Event live); `-` turns Pass 2 or 3 off.
 * One move per --interval ms, round-robin over Boards with moves left (0 = frozen at the initial state).
 * --rounds 0: an Event with no Rounds yet; 2: adds Round 2 (all Boards Upcoming, colours swapped), which the follower
 * swaps in --swap-in seconds after boot (its start is 10 min later); --poll is the follower's poll interval in ms.
 * --events N: follows N Events (1-9): `demo` (tourId demoEvnt, Rounds demoRnd1/2, games demo0001..) and `demo2`..`demoN`
 * (tourId demoEvn<k>, Rounds dem<k>Rnd1/2, games dem<k>0001.., players tagged `/k`). They share the --boards and move in
 * lockstep; the first is the Primary. More can be added from Admin: link `demo3`..`demo9`. All ids are 8 chars.
 * --crash-board N: the fake engine crashes on Board N's position at boot (2..boards, not the Upcoming --top Board), so
 * that Job lands in the Dead-letter queue after 3 crashes. Boards sharing its base game and position dead-letter too.
 * Archived Rounds land in <data>/rounds/demoEvnt/demoRnd1.json (Event id 8 chars: the Archive route validates ids).
 * stdin: a line `n` releases one move on Board n; an empty line, the next round-robin move.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import { engineConfig } from '../shared/engine-config.js';
import { passesError } from '../shared/passes.js';
import type { PassesMs } from '../shared/types.js';
import { SWAP_LEAD_MS } from '../shared/rollover.js';
import { Engine, probeEngine } from '../src/engine/engine.js';
import type { Board, EventInfo, RoundInfo } from '../src/lichess/api.js';
import type { GameUpdate, Source, SourceHandlers } from '../src/lichess/stream.js';
import { startServer } from '../src/server.js';
import { dataStore } from '../src/store.js';
import { ReplaySource } from '../test/helpers/replay-source.js';

const { values: v } = parseArgs({
  options: {
    port: { type: 'string', default: '18457' },
    boards: { type: 'string', default: '10' },
    top: { type: 'string', default: '8' },
    passes: { type: 'string', default: '300,1500,6000' },
    interval: { type: 'string', default: '1500' },
    data: { type: 'string' },
    password: { type: 'string', default: 'demo' },
    rounds: { type: 'string', default: '1' },
    'swap-in': { type: 'string', default: '20' },
    poll: { type: 'string', default: '2000' },
    'crash-board': { type: 'string' },
    events: { type: 'string', default: '1' },
  },
});
const [port, count, top, interval, rounds, swapIn, pollMs, events] = [
  v.port!,
  v.boards!,
  v.top!,
  v.interval!,
  v.rounds!,
  v['swap-in']!,
  v.poll!,
  v.events!,
].map(Number);
const passes = v.passes!.split(',').map((x) => (x === '-' ? null : Number(x))) as PassesMs;
if (passesError(passes, 3600_000)) {
  console.error(`--passes: ${passesError(passes, 3600_000)}`);
  process.exit(1);
}
if (!(events >= 1 && events <= 9)) {
  console.error('--events must be 1..9');
  process.exit(1);
}
const crashBoard = v['crash-board'] === undefined ? null : Number(v['crash-board']);
if (crashBoard !== null && !(crashBoard >= 2 && crashBoard <= count && crashBoard !== top)) {
  console.error(`--crash-board must be a Board in 2..${count} other than the Upcoming Board ${top}`);
  process.exit(1);
}
const data = v.data ?? mkdtempSync(join(tmpdir(), 'kibitzer-demo-'));
const FAKE = join(import.meta.dirname, '../test/fixtures/fake-uci.mjs');

// The fixture's games by gameId (last update wins), cycled over the Boards: finished, then two live ones.
const fixture = new Map<string, GameUpdate>();
for (const u of ReplaySource.fromFile('test/fixtures/lichess/round-stream.pgn').updates) fixture.set(u.gameId, u);
const games = ['qbPxmdQ2', 'at7GqSzo', 'gH77VTmz'].map((id) => fixture.get(id)!);
const suffix = (name: string, i: number | string) =>
  name.includes(',') ? name.replace(',', ` ${i},`) : `${name} ${i}`;

// Moves released so far per Board. Board 1 is finished, Board `top` Upcoming, the rest Live.
const base = (i: number) => games[(i - 1) % 3];
const shown = Array.from({ length: count }, (_, k) => {
  const i = k + 1;
  const full = base(i).uci.length;
  return i === 1 ? full : i === top ? 0 : Math.min(10 + 4 * i, full - 1);
});
// Event k (1-based): `demo` / `demo<k>`. Ids stay 8 chars (the Archive route validates them); Event 1 keeps its old ids.
const evKey = (k: number) => (k === 1 ? 'demo' : `dem${k}`);
const tourOf = (k: number) => (k === 1 ? 'demoEvnt' : `demoEvn${k}`);
const roundOf = (k: number, n: number) => (k === 1 ? `demoRnd${n}` : `dem${k}Rnd${n}`);
const gameId = (i: number, k = 1) => `${evKey(k)}${String(i).padStart(4, '0')}`;
const game2Id = (i: number, k: number) => `${k === 1 ? 'demo2' : `dm${k}`}_${String(i).padStart(4, '0')}`;
/** `demo3` -> 3; `demo` -> 1. */
const eventOfLink = (link: string) => (link === 'demo' ? 1 : Number(/^demo([2-9])$/.exec(link)?.[1] ?? NaN));
/** `dem3Rnd2` -> { k: 3, n: 2 }. */
const parseRound = (id: string) => {
  const m = /^(?:demoRnd|dem([2-9])Rnd)([12])$/.exec(id);
  return m ? { k: Number(m[1] ?? 1), n: Number(m[2]) } : null;
};
const result = (i: number) => (shown[i - 1] === base(i).uci.length ? base(i).result : '*');

function update(i: number, ev = 1): GameUpdate {
  const g = base(i);
  const k = shown[i - 1];
  const r = result(i);
  return {
    ...g,
    gameId: gameId(i, ev),
    white: { ...g.white, name: suffix(g.white.name, ev === 1 ? i : `${i}/${ev}`) },
    black: { ...g.black, name: suffix(g.black.name, ev === 1 ? i : `${i}/${ev}`) },
    uci: g.uci.slice(0, k),
    san: g.san.slice(0, k),
    clocks: g.clocks.slice(0, k),
    result: r,
    status: r === '*' ? 'ongoing' : 'finished',
  };
}

// One fake Lichess: the Event, the Rounds and the Source all read the state above. Round 2 starts 10 min after its swap.
const startsAt2 = Date.now() + swapIn * 1000 + SWAP_LEAD_MS;
const board = (u: GameUpdate): Board => ({
  id: u.gameId,
  name: `${u.white.name} - ${u.black.name}`,
  white: u.white,
  black: u.black,
  result: u.result,
});
const lichess = {
  fetchEvent: async (link: string): Promise<EventInfo> => {
    const k = eventOfLink(link);
    if (!(k >= 1 && k <= 9)) throw new Error(`demo link must be demo or demo2..demo9, got ${link}`);
    return {
      id: tourOf(k),
      name: k === 1 ? 'Demo Event' : `Demo Event ${k}`,
      rounds: [
        { id: roundOf(k, 1), name: 'Round 1', ongoing: true, finished: false },
        { id: roundOf(k, 2), name: 'Round 2', ongoing: false, finished: false, startsAt: startsAt2 },
      ].slice(0, rounds),
      defaultRoundId: roundOf(k, 1),
    };
  },
  fetchRound: async (id: string): Promise<RoundInfo> => {
    const { k, n } = parseRound(id)!;
    return {
      id,
      name: `Round ${n}`,
      tourId: tourOf(k),
      boards: Array.from({ length: count }, (_, j): Board => {
        const u = update(j + 1, k);
        if (n === 1) return board(u);
        return board({ ...u, gameId: game2Id(j + 1, k), white: u.black, black: u.white, result: '*' });
      }),
    };
  },
};

// Live Sources by handlers, with their Event; every release feeds all of them.
const handlers = new Map<SourceHandlers, number>();
const source = (roundId: string): Source => {
  let h: SourceHandlers;
  const r = parseRound(roundId);
  if (r?.n !== 1) return { start() {}, stop() {} }; // Round 2: no game has started
  return {
    start(x) {
      handlers.set((h = x), r.k);
      for (let i = 1; i <= count; i++) x.game(update(i, r.k));
    },
    stop: () => void handlers.delete(h),
  };
};

let cursor = 0;
function release(i?: number): void {
  if (i === undefined) {
    const open = Array.from({ length: count }, (_, k) => k + 1).filter((n) => shown[n - 1] < base(n).uci.length);
    i = open.find((n) => n > cursor) ?? open[0];
    if (i === undefined) return;
    cursor = i;
  }
  if (!(i >= 1 && i <= count) || shown[i - 1] >= base(i).uci.length) return;
  shown[i - 1]++;
  for (const [h, k] of handlers) h.game(update(i, k));
}

const crash =
  crashBoard === null
    ? []
    : [
        '--crash-on',
        base(crashBoard)
          .uci.slice(0, shown[crashBoard - 1])
          .join(' '),
      ];

const running = await startServer({
  port,
  store: dataStore(join(data, 'state.json')),
  defaultEngine: engineConfig('fake'),
  adminPassword: v.password,
  scheduler: {
    // The Lines copy scores 0.08 higher, so the main line and the Lines visibly disagree.
    launch: (_cfg, role) =>
      Engine.start(process.execPath, {
        args: [FAKE, '--legal-pv', ...(role === 'multi' ? ['--offset', '8'] : []), ...crash],
      }),
    source,
  },
  app: { probe: () => probeEngine(process.execPath, { args: [FAKE] }) },
  lichess,
  follow: { pollMs }, // polls the fake lichess above, never lichess.org
});
const { scheduler, site } = running;
await scheduler.setPasses(passes);
for (let k = 1; k <= events; k++) await site.add(k === 1 ? 'demo' : `demo${k}`, top);

if (interval > 0) setInterval(release, interval);
createInterface({ input: process.stdin }).on('line', (l) => release(l.trim() ? Number(l) : undefined));
for (const sig of ['SIGTERM', 'SIGINT'] as const)
  process.once(sig, () => void running.shutdown().finally(() => process.exit(0)));
console.log(`Demo: http://localhost:${running.port}/  admin password: ${v.password}  data: ${data}`);
