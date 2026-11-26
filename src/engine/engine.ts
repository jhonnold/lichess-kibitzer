import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { basename } from 'node:path';
import { createInterface, type Interface } from 'node:readline';
import { parseLine, type UciInfo, type UciOption } from './uci-parser.js';

export type SearchLimit = 'infinite' | { movetime: number };
export interface SearchResult {
  bestmove: string;
  info?: UciInfo; // last unbounded multipv-1 info (v1 Kibitzer reads it)
  lines: UciInfo[]; // per multipv: last unbounded info of this search, ordered by multipv
}
export interface StartOptions {
  args?: string[];
  timeoutMs?: number; // time allowed for `uciok`, default 5000
}
type Events = {
  info: [UciInfo];
  exit: [code: number | null, signal: NodeJS.Signals | null];
};

interface Active {
  resolve: (r: SearchResult) => void;
  reject: (e: Error) => void;
  lines: Map<number, UciInfo>; // multipv -> last unbounded info
  stopSent: boolean;
}

const noop = () => {};

/** One UCI engine process. Commands that must not interleave with a search are queued; stop and quit bypass the queue. */
export class Engine extends EventEmitter<Events> {
  private queue: Promise<unknown> = Promise.resolve();
  private active?: Active;
  private readyWaiters: { resolve: () => void; reject: (e: Error) => void }[] = [];
  private stopGen = 0;
  private lastSearch?: Promise<SearchResult>;
  private hasExited = false;

  private constructor(
    private readonly proc: ChildProcess,
    private readonly rl: Interface,
    readonly name: string,
    readonly options: UciOption[],
  ) {
    super();
    rl.on('line', this.onLine);
    proc.on('exit', this.onExit);
  }

  static async start(command: string, opts: StartOptions = {}): Promise<Engine> {
    const ms = opts.timeoutMs ?? 5000;
    const proc = spawn(command, opts.args ?? [], { stdio: ['pipe', 'pipe', 'ignore'] });
    proc.stdin!.on('error', noop);
    proc.on('error', noop);
    const rl = createInterface({ input: proc.stdout! });
    return new Promise<Engine>((resolve, reject) => {
      let name = basename(command);
      const options: UciOption[] = [];
      const cleanup = () => {
        clearTimeout(timer);
        rl.off('line', onLine);
        proc.off('error', onError);
        proc.off('exit', onExit);
      };
      const fail = (err: Error) => {
        cleanup();
        proc.kill('SIGKILL');
        rl.close();
        reject(err);
      };
      const onLine = (line: string) => {
        const m = parseLine(line);
        if (m?.type === 'id') name = m.name;
        else if (m?.type === 'option') options.push(m.option);
        else if (m?.type === 'uciok') {
          cleanup();
          resolve(new Engine(proc, rl, name, options));
        }
      };
      const onError = (e: Error) => fail(e);
      const onExit = () => fail(new Error('engine exited before uciok'));
      const timer = setTimeout(() => fail(new Error(`not a UCI engine: no uciok within ${ms}ms`)), ms);
      rl.on('line', onLine);
      proc.on('error', onError);
      proc.on('exit', onExit);
      proc.stdin!.write('uci\n');
    });
  }

  get exited(): boolean {
    return this.hasExited;
  }

  /** Queued. No value sends a button-style option. */
  setOption(name: string, value?: string | number | boolean): void {
    const cmd = value === undefined ? `setoption name ${name}` : `setoption name ${name} value ${value}`;
    void this.enqueue(async () => this.send(cmd));
  }

  /** Queued. Resolves on `readyok`. */
  isReady(): Promise<void> {
    return this.enqueue(
      () =>
        new Promise<void>((resolve, reject) => {
          this.readyWaiters.push({ resolve, reject });
          this.send('isready');
        }),
    );
  }

  /** Queued. Resolves on `bestmove`. A later `stop()` also stops this search, running or still queued. */
  search(moves: string[], limit: SearchLimit): Promise<SearchResult> {
    const gen = this.stopGen;
    const p = this.enqueue(
      () =>
        new Promise<SearchResult>((resolve, reject) => {
          this.active = { resolve, reject, lines: new Map(), stopSent: false };
          this.send(moves.length ? `position startpos moves ${moves.join(' ')}` : 'position startpos');
          this.send(limit === 'infinite' ? 'go infinite' : `go movetime ${limit.movetime}`);
          if (this.stopGen !== gen) this.sendStop();
        }),
    );
    this.lastSearch = p;
    p.finally(() => {
      if (this.lastSearch === p) this.lastSearch = undefined;
    }).catch(noop);
    return p;
  }

  /** Stops every search enqueued so far. Resolves with the last one's result, or undefined if none. */
  stop(): Promise<SearchResult | undefined> {
    this.stopGen++;
    this.sendStop();
    return this.lastSearch ?? Promise.resolve(undefined);
  }

  /** Sends `quit`; SIGKILLs the process if it has not exited after timeoutMs. */
  quit(timeoutMs = 1000): Promise<void> {
    if (this.hasExited) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const t = setTimeout(() => this.proc.kill('SIGKILL'), timeoutMs);
      this.proc.once('exit', () => {
        clearTimeout(t);
        resolve();
      });
      this.send('quit');
    });
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const p = this.queue.then(() => {
      if (this.hasExited) throw new Error('engine exited');
      return task();
    });
    this.queue = p.catch(noop);
    p.catch(noop);
    return p;
  }

  private send(cmd: string): void {
    if (!this.hasExited && this.proc.stdin?.writable) this.proc.stdin.write(cmd + '\n');
  }

  private sendStop(): void {
    const a = this.active;
    if (a && !a.stopSent) {
      this.send('stop');
      a.stopSent = true;
    }
  }

  private onLine = (line: string) => {
    const m = parseLine(line);
    if (m?.type === 'info' && m.info.score) {
      if (this.active && !m.info.score.bound) this.active.lines.set(m.info.multipv, m.info);
      this.emit('info', m.info);
    } else if (m?.type === 'readyok') {
      this.readyWaiters.shift()?.resolve();
    } else if (m?.type === 'bestmove') {
      const a = this.active;
      this.active = undefined;
      if (!a) return;
      const lines = [...a.lines.values()].sort((x, y) => x.multipv - y.multipv);
      a.resolve({ bestmove: m.move, info: a.lines.get(1), lines });
    }
  };

  private onExit = (code: number | null, signal: NodeJS.Signals | null) => {
    this.hasExited = true;
    const err = new Error('engine exited');
    const a = this.active;
    this.active = undefined;
    a?.reject(err);
    for (const w of this.readyWaiters.splice(0)) w.reject(err);
    this.emit('exit', code, signal);
  };
}

export async function probeEngine(
  command: string,
  opts?: StartOptions,
): Promise<{ name: string; options: UciOption[] }> {
  const e = await Engine.start(command, opts);
  await e.quit();
  return { name: e.name, options: e.options };
}
