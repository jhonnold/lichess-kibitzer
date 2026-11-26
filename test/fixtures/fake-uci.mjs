// Fake UCI engine for tests. Flags: --log <file>, --no-uciok, --ignore-quit, --exit-on-go,
// --crash-on <moves> (exit 3 on go after `position startpos moves <moves>`; '' = start position),
// --ply-score (cp = 100 * plies + 10 * depth - multipv, so 29 at depth 3 / multipv 1 from the start),
// --legal-pv (line k = the k-th legal move + the first legal reply; cp = 10 * depth + [40, 30, -20, -100, -300][k - 1]
// from the side to move, so 70/60/10/-70/-270 at depth 3; overrides --ply-score), --offset <cp> (added to every score).
// bestmove = the first move of the last multipv 1 line (e2e4 before any).
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const argv = process.argv.slice(2);
const flag = (f) => argv.includes(f);
const logPath = argv.includes('--log') ? argv[argv.indexOf('--log') + 1] : null;
const log = (l) => logPath && appendFileSync(logPath, l + '\n');
const crashOn = argv.includes('--crash-on') ? argv[argv.indexOf('--crash-on') + 1] : null;
const { Chess } = flag('--legal-pv') ? await import('chess.js') : {};
const OFFSET = [40, 30, -20, -100, -300];
const out = (l) => process.stdout.write(l + '\n');

let multipv = 1;
let moves = ''; // space-joined UCI moves of the last `position`
let pending = null; // { timer } while searching
let best = 'e2e4';
const offset = argv.includes('--offset') ? Number(argv[argv.indexOf('--offset') + 1]) : 0;

const finish = () => {
  if (!pending) return;
  clearTimeout(pending.timer);
  pending = null;
  log(`> bestmove ${best}`);
  out(`bestmove ${best}`);
};

createInterface({ input: process.stdin }).on('line', (line) => {
  log(line);
  const [cmd, ...rest] = line.trim().split(/\s+/);
  if (cmd === 'uci') {
    out('id name FakeEngine');
    out('option name Threads type spin default 1 min 1 max 512');
    out('option name Hash type spin default 16 min 1 max 33554432');
    out('option name MultiPV type spin default 1 min 1 max 256');
    out('option name Clear Hash type button');
    if (!flag('--no-uciok')) out('uciok');
  } else if (cmd === 'isready') {
    out('readyok');
  } else if (cmd === 'setoption' && /^name MultiPV value \d+$/.test(rest.join(' '))) {
    multipv = Number(rest[3]);
  } else if (cmd === 'position') {
    moves = rest.slice(2).join(' ');
  } else if (cmd === 'go') {
    if (flag('--exit-on-go') || moves === crashOn) process.exit(3);
    out('info string fake search');
    const base = flag('--ply-score') ? 100 * (moves ? moves.split(' ').length : 0) : 0;
    let legal = null;
    if (Chess) {
      const chess = new Chess();
      for (const m of moves ? moves.split(' ') : [])
        chess.move({ from: m.slice(0, 2), to: m.slice(2, 4), promotion: m[4] });
      legal = chess.moves({ verbose: true });
    }
    const lan = (m) => m.from + m.to + (m.promotion ?? '');
    for (let d = 1; d <= 3; d++)
      for (let k = 1; k <= multipv; k++) {
        let score = base + 10 * d - k;
        let pv = 'e2e4 e7e5';
        if (legal) {
          if (!legal[k - 1]) continue;
          const chess = new Chess(legal[k - 1].before);
          chess.move(legal[k - 1].san);
          const reply = chess.moves({ verbose: true })[0];
          pv = lan(legal[k - 1]) + (reply ? ' ' + lan(reply) : '');
          score = 10 * d + (OFFSET[k - 1] ?? -300 - 100 * (k - 5));
        }
        score += offset;
        if (k === 1) best = pv.split(' ')[0];
        out(
          `info depth ${d} seldepth ${d + 2} multipv ${k} score cp ${score} nodes ${1000 * d} nps 100000 time ${d} pv ${pv}`,
        );
      }
    out('info depth 4 multipv 1 score cp 99 lowerbound nodes 4000 nps 100000 time 4 pv e2e4');
    const mt = rest[0] === 'movetime' ? Number(rest[1]) : null;
    pending = { timer: mt === null ? undefined : setTimeout(finish, mt) };
  } else if (cmd === 'stop') {
    finish();
  } else if (cmd === 'quit' && !flag('--ignore-quit')) {
    process.exit(0);
  }
});
