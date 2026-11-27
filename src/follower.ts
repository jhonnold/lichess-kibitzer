import { rollover } from '../shared/rollover.js';
import type { EventInfo, RoundInfo } from './lichess/api.js';
import { followerPolls } from './metrics.js';
import type { Scheduler } from './scheduler.js';
import type { RoundState } from './round-state.js';
import type { SiteState } from './site-state.js';
import type { DataStore } from './store.js';

export const POLL_MS = 60_000;

export interface LichessClient {
  fetchEvent(link: string): Promise<EventInfo>;
  fetchRound(roundId: string): Promise<RoundInfo>;
  fetchOpening?(uci: readonly string[]): Promise<string | null>;
}

export interface FollowerOpts {
  lichess: LichessClient;
  store: Pick<DataStore, 'loadRound'>;
  now?: () => number; // default Date.now
  pollMs?: number; // default POLL_MS (demo uses less)
  every?: (ms: number, fn: () => void) => () => void; // default setInterval(unref) → cancel; tests: a stub
}

export interface FollowStatus {
  next: { roundId: string; name: string; startsAt: number | null } | null;
  swapAt: number | null; // null: no next Round, or it has no startsAt (swap when Lichess says ongoing)
  polledAt: number | null; // last successful fetchEvent
  error: string | null; // last poll/swap error, cleared on success
}

export const IDLE: FollowStatus = { next: null, swapAt: null, polledAt: null, error: null };

const everyInterval = (ms: number, fn: () => void) => {
  const timer = setInterval(fn, ms);
  timer.unref();
  return () => clearInterval(timer);
};

/** Follows one registered Event: polls it and makes that Event's Current Round the one `rollover` picks. */
export class Follower {
  private st: FollowStatus = IDLE;
  private cancel: (() => void) | null = null;
  private stopped = false;
  private timerTick: Promise<void> | null = null;
  private ops: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly site: SiteState,
    readonly tourId: string,
    private readonly scheduler: Pick<Scheduler, 'startRound'>,
    private readonly opts: FollowerOpts,
  ) {}

  get status(): FollowStatus {
    return { ...this.st };
  }

  private get state(): RoundState | null {
    return this.site.event(this.tourId) ?? null;
  }

  /** Starts polling (idempotent), then applies the fetched Event. */
  follow(ev: EventInfo): Promise<void> {
    return this.serial(async () => {
      if (this.stopped) return;
      this.poll();
      await this.apply(ev);
    });
  }

  /** Boot: start polling and tick once. */
  async resume(): Promise<void> {
    this.poll();
    await this.tick();
  }

  /** One poll. Never rejects: errors go to status.error and the Current Round is kept. */
  tick(): Promise<void> {
    return this.serial(async () => {
      const event = this.state?.event;
      if (!event || this.stopped) return;
      let ev: EventInfo;
      try {
        ev = await this.opts.lichess.fetchEvent(event.link);
      } catch (err) {
        this.st = { ...this.st, error: message(err) };
        followerPolls.inc({ event: this.tourId, outcome: 'error' });
        return;
      }
      await this.apply(ev);
      followerPolls.inc({ event: this.tourId, outcome: this.st.error ? 'error' : 'ok' });
    });
  }

  /** Shutdown: cancel polling, wait for the running operation (no tick starts a Round after this). */
  async stop(): Promise<void> {
    this.stopped = true;
    this.cancel?.();
    this.cancel = null;
    await this.ops;
  }

  private poll(): void {
    // A slow poll is not queued behind: timer ticks never pile up into a burst of Lichess requests.
    this.cancel ??= (this.opts.every ?? everyInterval)(this.opts.pollMs ?? POLL_MS, () => {
      this.timerTick ??= this.tick().finally(() => (this.timerTick = null));
    });
  }

  private serial(op: () => Promise<void>): Promise<void> {
    const p = this.ops.then(op);
    this.ops = p.catch(() => {});
    return p;
  }

  private get now(): number {
    return (this.opts.now ?? Date.now)();
  }

  /** Swap to the Round `rollover` picks (opening its file if it has one), or fill a zero-Board Round. Errors are
   *  recorded, never thrown. */
  private async apply(ev: EventInfo): Promise<void> {
    const { lichess, store } = this.opts;
    let error: string | null = null;
    if (!this.state) return;
    try {
      const cur = this.state!.round?.roundId ?? null;
      const { current } = rollover(ev.rounds, cur, this.now);
      if (current && current.id !== cur) {
        const info = await lichess.fetchRound(current.id);
        await this.site.saved(); // writes are coalesced: the file read below must include the last one
        const existing = await store.loadRound(info.tourId, info.id);
        await this.scheduler.startRound(info.tourId, info, current.startsAt ?? null, existing);
      } else if (cur && this.state!.round!.boards.length === 0) {
        const info = await lichess.fetchRound(cur);
        if (info.boards.length) await this.scheduler.startRound(info.tourId, info, current?.startsAt ?? null);
      } else if (cur && this.state!.hasUnknownBoards) {
        // At most once per poll; the game's moves are recorded from its next update on.
        this.state!.addBoards((await lichess.fetchRound(cur)).boards);
      }
      const shown = ev.rounds.find((r) => r.id === this.state!.round?.roundId);
      if (shown) this.state!.setStartsAt(shown.startsAt ?? null);
    } catch (err) {
      error = message(err);
    }
    const { next, swapAt } = rollover(ev.rounds, this.state?.round?.roundId ?? null, this.now);
    this.st = {
      next: next && { roundId: next.id, name: next.name, startsAt: next.startsAt ?? null },
      swapAt,
      polledAt: this.now,
      error,
    };
  }
}

const message = (err: unknown) => String((err as Error | undefined)?.message ?? err);
