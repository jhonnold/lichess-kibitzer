/**
 * Demo server for manual checks and screenshots: the real server with the fake engine and a synthesized Round built
 * from test/fixtures/lichess/round-stream.pgn. Never contacts lichess.org.
 *   npm run build && npm run demo -- [--port 18457] [--boards 10] [--top 8] [--job-time 800] [--interval 1500]
 *                                    [--data DIR] [--password demo]
 * One move per --interval ms, round-robin over Boards with moves left (0 = frozen at the initial state).
 * stdin: a line `n` releases one move on Board n; an empty line, the next round-robin move.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
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
    'job-time': { type: 'string', default: '800' },
    interval: { type: 'string', default: '1500' },
    data: { type: 'string' },
    password: { type: 'string', default: 'demo' },
  },
});
const [port, count, top, jobTime, interval] = [v.port!, v.boards!, v.top!, v['job-time']!, v.interval!].map(Number);
const data = v.data ?? mkdtempSync(join(tmpdir(), 'kibitzer-demo-'));
const FAKE = join(import.meta.dirname, '../test/fixtures/fake-uci.mjs');

// The fixture's games by gameId (last update wins), cycled over the Boards: finished, then two live ones.
const fixture = new Map<string, GameUpdate>();
for (const u of ReplaySource.fromFile('test/fixtures/lichess/round-stream.pgn').updates) fixture.set(u.gameId, u);
const games = ['qbPxmdQ2', 'at7GqSzo', 'gH77VTmz'].map((id) => fixture.get(id)!);
const suffix = (name: string, i: number) => (name.includes(',') ? name.replace(',', ` ${i},`) : `${name} ${i}`);

// Moves released so far per Board. Board 1 is finished, Board `top` Upcoming, the rest Live.
const base = (i: number) => games[(i - 1) % 3];
const shown = Array.from({ length: count }, (_, k) => {
  const i = k + 1;
  const full = base(i).uci.length;
  return i === 1 ? full : i === top ? 0 : Math.min(10 + 4 * i, full - 1);
});
const gameId = (i: number) => `demo${String(i).padStart(4, '0')}`;
const result = (i: number) => (shown[i - 1] === base(i).uci.length ? base(i).result : '*');

function update(i: number): GameUpdate {
  const g = base(i);
  const k = shown[i - 1];
  const r = result(i);
  return {
    ...g,
    gameId: gameId(i),
    white: { ...g.white, name: suffix(g.white.name, i) },
    black: { ...g.black, name: suffix(g.black.name, i) },
    uci: g.uci.slice(0, k),
    san: g.san.slice(0, k),
    clocks: g.clocks.slice(0, k),
    result: r,
    status: r === '*' ? 'ongoing' : 'finished',
  };
}

// One fake Lichess: the Event, the Round and the Source all read the state above.
const lichess = {
  fetchEvent: async (): Promise<EventInfo> => ({
    id: 'demo',
    name: 'Demo Event',
    rounds: [{ id: 'demoRnd1', name: 'Round 1', ongoing: true, finished: false }],
    defaultRoundId: 'demoRnd1',
  }),
  fetchRound: async (): Promise<RoundInfo> => ({
    id: 'demoRnd1',
    name: 'Round 1',
    tourId: 'demo',
    boards: Array.from({ length: count }, (_, k): Board => {
      const u = update(k + 1);
      return {
        id: u.gameId,
        name: `${u.white.name} - ${u.black.name}`,
        white: u.white,
        black: u.black,
        result: u.result,
      };
    }),
  }),
};

const handlers = new Set<SourceHandlers>();
const source = (): Source => {
  let h: SourceHandlers;
  return {
    start(x) {
      handlers.add((h = x));
      for (let i = 1; i <= count; i++) x.game(update(i));
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
  for (const h of handlers) h.game(update(i));
}

const running = await startServer({
  port,
  store: dataStore(join(data, 'state.json')),
  defaultEngine: { path: 'fake', options: {} },
  adminPassword: v.password,
  scheduler: {
    launch: () => Engine.start(process.execPath, { args: [FAKE, '--ply-score'] }),
    source,
  },
  app: { probe: () => probeEngine(process.execPath, { args: [FAKE] }) },
  lichess,
  follow: { pollMs: 60_000 }, // polls the fake lichess above, never lichess.org
});
const { state, scheduler, follower } = running;
state.setTopN(top);
await scheduler.setJobTime(jobTime);
await follower.register('demo');

if (interval > 0) setInterval(release, interval);
createInterface({ input: process.stdin }).on('line', (l) => release(l.trim() ? Number(l) : undefined));
for (const sig of ['SIGTERM', 'SIGINT'] as const)
  process.once(sig, () => void running.shutdown().finally(() => process.exit(0)));
console.log(`Demo: http://localhost:${running.port}/  admin password: ${v.password}  data: ${data}`);
