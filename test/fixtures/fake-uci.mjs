// Fake UCI engine for tests. Flags: --log <file>, --no-uciok, --ignore-quit, --exit-on-go,
// --crash-on <moves> (exit 3 on go after `position startpos moves <moves>`; '' = start position),
// --ply-score (cp = 100 * plies + 10 * depth - multipv, so 29 at depth 3 / multipv 1 from the start).
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const argv = process.argv.slice(2);
const flag = (f) => argv.includes(f);
const logPath = argv.includes('--log') ? argv[argv.indexOf('--log') + 1] : null;
const log = (l) => logPath && appendFileSync(logPath, l + '\n');
const crashOn = argv.includes('--crash-on') ? argv[argv.indexOf('--crash-on') + 1] : null;
const out = (l) => process.stdout.write(l + '\n');

let multipv = 1;
let moves = ''; // space-joined UCI moves of the last `position`
let pending = null; // { timer } while searching

const finish = () => {
  if (!pending) return;
  clearTimeout(pending.timer);
  pending = null;
  log('> bestmove e2e4');
  out('bestmove e2e4 ponder e7e5');
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
    for (let d = 1; d <= 3; d++)
      for (let k = 1; k <= multipv; k++)
        out(
          `info depth ${d} seldepth ${d + 2} multipv ${k} score cp ${base + 10 * d - k} nodes ${1000 * d} nps 100000 time ${d} pv e2e4 e7e5`,
        );
    out('info depth 4 multipv 1 score cp 99 lowerbound nodes 4000 nps 100000 time 4 pv e2e4');
    const mt = rest[0] === 'movetime' ? Number(rest[1]) : null;
    pending = { timer: mt === null ? undefined : setTimeout(finish, mt) };
  } else if (cmd === 'stop') {
    finish();
  } else if (cmd === 'quit' && !flag('--ignore-quit')) {
    process.exit(0);
  }
});
