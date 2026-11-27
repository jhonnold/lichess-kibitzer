import { defaultTopN } from '../shared/events.js';
import type * as T from '../shared/types.js';
import { Follower, type FollowerOpts, type FollowStatus } from './follower.js';
import type { Scheduler } from './scheduler.js';
import type { SiteState } from './site-state.js';

/** The followed Events: one Follower each. Lock order Site > Follower > Scheduler; nothing calls upward. */
export class Site {
  private readonly followers = new Map<string, Follower>();
  private ops: Promise<unknown> = Promise.resolve();
  private stopped = false;

  constructor(
    private readonly state: SiteState,
    private readonly scheduler: Pick<Scheduler, 'startRound' | 'removeEvent'>,
    private readonly opts: FollowerOpts,
  ) {}

  /** fetchEvent(link) (rejects: bad link, LichessError; nothing registered). A known tourId is only ticked (topN
   *  ignored). Else the Event is registered with `topN` (default: the share of DEFAULT_TOP_N) and followed. */
  add(link: string, topN?: number): Promise<T.RegisteredEvent> {
    return this.serial(async () => {
      if (this.stopped) throw new Error('stopped');
      const ev = await this.opts.lichess.fetchEvent(link);
      const known = this.state.event(ev.id);
      const rs =
        known ??
        this.state.addEvent({ tourId: ev.id, name: ev.name, link }, topN ?? defaultTopN(this.state.events.length + 1));
      await this.ensure(ev.id).follow(ev);
      return rs.event;
    });
  }

  /** Stops its Follower, then removes the Event (the Primary passes to the oldest remaining). False: unknown. */
  remove(tourId: string): Promise<boolean> {
    return this.serial(async () => {
      if (this.stopped || !this.state.event(tourId)) return false;
      await this.followers.get(tourId)?.stop();
      this.followers.delete(tourId);
      await this.scheduler.removeEvent(tourId);
      return true;
    });
  }

  setPrimary(tourId: string): boolean {
    return this.state.setPrimary(tourId);
  }

  status(tourId: string): FollowStatus | null {
    return this.followers.get(tourId)?.status ?? null;
  }

  follower(tourId: string): Follower | undefined {
    return this.followers.get(tourId);
  }

  /** Boot: follow every persisted Event, one at a time (fewer bursts against a shared 429 pause). */
  resume(): Promise<void> {
    return this.serial(async () => {
      if (this.stopped) return;
      for (const rs of this.state.events) {
        await this.ensure(rs.event.tourId).resume();
      }
    });
  }

  /** Shutdown: every Follower stops (waiting for its in-flight tick) before the caller stops the Scheduler. */
  async stop(): Promise<void> {
    this.stopped = true;
    await this.ops.catch(() => {});
    await Promise.all([...this.followers.values()].map((f) => f.stop()));
  }

  private ensure(tourId: string): Follower {
    let f = this.followers.get(tourId);
    if (!f) this.followers.set(tourId, (f = new Follower(this.state, tourId, this.scheduler, this.opts)));
    return f;
  }

  private serial<R>(op: () => Promise<R>): Promise<R> {
    const p = this.ops.then(op);
    this.ops = p.catch(() => {});
    return p;
  }
}
