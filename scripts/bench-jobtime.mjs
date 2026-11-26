// Job time benchmark: how long does a UCI engine take to reach depth N (MultiPV 5, 1 thread),
// and what depth does it reach in a fixed movetime? See docs/jobtime.md.
// Usage: node scripts/bench-jobtime.mjs [--depth 36] [--movetime 5000,10000,15000,20000] [--cap-ms 600000]
//        [--plies 12,24,36,48,60] [--pgn test/fixtures/lichess/round-stream.pgn] -- <engine> [engine args...]
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import { Chess } from 'chess.js';

const sep = process.argv.indexOf('--');
const { values: opt } = parseArgs({
  args: process.argv.slice(2, sep < 0 ? undefined : sep),
  options: {
    depth: { type: 'string', default: '36' },
    movetime: { type: 'string', default: '5000,10000,15000,20000' },
    'cap-ms': { type: 'string', default: '600000' },
    plies: { type: 'string', default: '12,24,36,48,60' },
    pgn: { type: 'string', default: 'test/fixtures/lichess/round-stream.pgn' },
  },
});
const engineCmd = sep < 0 ? [] : process.argv.slice(sep + 1);
if (!engineCmd.length) {
  console.error('usage: bench-jobtime.mjs [options] -- <engine> [args...]');
  process.exit(2);
}
const depthTarget = Number(opt.depth);
const capMs = Number(opt['cap-ms']);
const plies = opt.plies.split(',').filter(Boolean).map(Number);
const movetimes = opt.movetime.split(',').filter(Boolean).map(Number);
const milestones = [...new Set([20, 24, 28, 32, 36, depthTarget])]
  .filter((m) => m <= depthTarget)
  .sort((a, b) => a - b);

const pct = (sorted, p) => sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)];
const fmt = (ms) => (ms == null ? '>cap' : (ms / 1000).toFixed(1));

function loadPositions(file) {
  const games = new Map(); // id -> uci moves (last snapshot wins)
  for (const chunk of readFileSync(file, 'utf8').split(/\n\s*\n(?=\[Event )/)) {
    const id = /\[GameURL "[^"]*\/([^/"]+)"\]/.exec(chunk)?.[1];
    if (!id) continue;
    const c = new Chess();
    c.loadPgn(chunk.replace(/\{[^}]*\}/g, ''));
    games.set(
      id,
      c.history({ verbose: true }).map((m) => m.lan),
    );
  }
  const out = [];
  for (const [id, moves] of games) {
    for (const ply of plies) {
      if (ply >= moves.length) continue;
      const phase = ply <= 16 ? 'opening' : ply <= 40 ? 'middlegame' : 'late middlegame';
      out.push({ label: `${id}@${ply}`, phase, cmd: `position startpos moves ${moves.slice(0, ply).join(' ')}` });
    }
  }
  return out;
}

const eng = spawn(engineCmd[0], engineCmd.slice(1), { stdio: ['pipe', 'pipe', 'inherit'] });
const send = (l) => eng.stdin.write(l + '\n');
let listener = null;
createInterface({ input: eng.stdout }).on('line', (l) => listener?.(l));
const waitFor = (re) =>
  new Promise((res) => {
    listener = (l) => {
      if (re.test(l)) {
        listener = null;
        res(l);
      }
    };
  });

let engineName = '?';
{
  const p = new Promise((res) => {
    listener = (l) => {
      if (l.startsWith('id name ')) engineName = l.slice(8);
      if (l === 'uciok') res();
    };
  });
  send('uci');
  await p;
}
for (const o of ['Threads 1', 'Hash 1024', 'MultiPV 5'])
  send(`setoption name ${o.split(' ')[0]} value ${o.split(' ')[1]}`);
send('isready');
await waitFor(/^readyok$/);

// Runs one search; returns { samples: [{depth, time}], capped }.
async function search(pos, go) {
  send('ucinewgame');
  send('isready');
  await waitFor(/^readyok$/);
  send(pos.cmd);
  const samples = [];
  let capped = false;
  const done = new Promise((res) => {
    listener = (l) => {
      if (l.startsWith('info ')) {
        const t = l.split(' ');
        const at = (k) => t.indexOf(k);
        const mpv = at('multipv') >= 0 ? Number(t[at('multipv') + 1]) : 1;
        if (mpv !== 1 || at('depth') < 0 || at('score') < 0 || at('time') < 0) return;
        if (t.includes('lowerbound') || t.includes('upperbound')) return;
        samples.push({ depth: Number(t[at('depth') + 1]), time: Number(t[at('time') + 1]) });
      } else if (l.startsWith('bestmove')) {
        listener = null;
        res();
      }
    };
  });
  send(go);
  const timer = setTimeout(() => {
    capped = true;
    send('stop');
  }, capMs);
  await done;
  clearTimeout(timer);
  return { samples, capped };
}

const positions = loadPositions(opt.pgn);
console.log(`# jobtime benchmark ${new Date().toISOString()}`);
console.log(`engine: ${engineName}`);
console.log(`cpu: ${cpus()[0].model}; threads: 1; hash: 1024 MB; MultiPV 5; ucinewgame before each search`);
console.log(
  `positions: ${positions.length} from ${opt.pgn} (plies ${plies.join(',')}); note: fixture games are <= 66 plies, no real endgames`,
);
console.log(`depth mode: go depth ${depthTarget}, cap ${capMs / 1000} s per position`);

if (depthTarget > 0) {
  const rows = [];
  console.log(`\n| position | phase | ${milestones.map((m) => `t${m}`).join(' | ')} | reached | capped |`);
  console.log(`|---|---|${milestones.map(() => '---').join('|')}|---|---|`);
  for (const pos of positions) {
    const { samples, capped } = await search(pos, `go depth ${depthTarget}`);
    const t = milestones.map((m) => samples.find((s) => s.depth >= m)?.time ?? null);
    const reached = samples.length ? samples[samples.length - 1].depth : 0;
    rows.push({ t, capped });
    console.log(`| ${pos.label} | ${pos.phase} | ${t.map(fmt).join(' | ')} | ${reached} | ${capped ? 'yes' : 'no'} |`);
  }
  console.log('\n| depth | n reached | median s | p95 s |\n|---|---|---|---|');
  milestones.forEach((m, i) => {
    const v = rows
      .map((r) => r.t[i])
      .filter((x) => x != null)
      .sort((a, b) => a - b);
    console.log(
      `| ${m} | ${v.length}/${rows.length} | ${v.length ? fmt(pct(v, 0.5)) : '-'} | ${v.length ? fmt(pct(v, 0.95)) : '-'} |`,
    );
  });
  console.log(`capped: ${rows.filter((r) => r.capped).length} of ${rows.length}`);
}

for (const T of movetimes) {
  const depths = [];
  console.log(`\nmovetime ${T} ms:`);
  for (const pos of positions) {
    const { samples } = await search(pos, `go movetime ${T}`);
    const d = samples.length ? samples[samples.length - 1].depth : 0;
    depths.push(d);
    console.log(`  ${pos.label}: depth ${d}`);
  }
  const s = [...depths].sort((a, b) => a - b);
  console.log(`movetime ${T} ms: n=${s.length} median depth ${pct(s, 0.5)}, p5 depth ${pct(s, 0.05)}`);
}

send('quit');
eng.stdin.end();
