import { EventEmitter } from 'node:events';
import * as T from '../shared/types.js';
import { RoundState, type RoundHost } from './round-state.js';
import type { DataStore } from './store.js';

/** `tourId` is the owning Event; null = site-wide (queue, a search of no Event). */
export type SiteEvents = {
  event: [tourId: string | null, e: T.SseEvent];
  primary: [tourId: string | null];
};

export const EMPTY_QUEUE: T.QueueView = { current: [], backfill: 0, deferred: [] };

/** In-memory site state: the site settings, one RoundState per registered Event, the Primary, and the transient
 *  search/queue. The only emitter: RoundState events arrive tagged with their Event. Persisted parts are saved on
 *  every change. */
export class SiteState extends EventEmitter<SiteEvents> {
  #settings: T.SiteSettings;
  #primary: string | null;
  #events = new Map<string, RoundState>(); // registration order
  #retired: Promise<void> = Promise.resolve(); // Round writes of removed Events
  #search: T.SearchInfo | null = null;
  #searchTour: string | null = null;
  #queue: T.QueueView = EMPTY_QUEUE;
  #seq = 0; // epochs are never reused, across Rounds, Events and re-adds
  #stateSaving: Promise<void> = Promise.resolve();
  #lastEvents = ''; // the summaries last emitted, as JSON

  constructor(
    private readonly store: DataStore,
    init: { state: T.PersistedState | null; rounds?: ReadonlyMap<string, T.Round> } = { state: null },
  ) {
    super();
    this.setMaxListeners(0); // one listener per SSE client; default cap 10 would warn
    this.#settings = init.state?.settings ?? { engine: null, jobTimeMs: T.DEFAULT_JOB_TIME_MS };
    this.#primary = init.state?.primary ?? null;
    for (const entry of init.state?.events ?? []) {
      this.#events.set(entry.event.tourId, this.#make(entry, init.rounds?.get(entry.event.tourId) ?? null));
    }
    this.#lastEvents = JSON.stringify(this.summaries());
  }

  /** load() then loadRound(current) of every Event that has a Current Round. */
  static async load(store: DataStore): Promise<SiteState> {
    const state = await store.load();
    const rounds = new Map<string, T.Round>();
    for (const { event, current } of state?.events ?? []) {
      const round = current && (await store.loadRound(current.tourId, current.roundId));
      if (round) rounds.set(event.tourId, round);
    }
    return new SiteState(store, { state, rounds });
  }

  get settings(): Readonly<T.SiteSettings> {
    return this.#settings;
  }
  /** The persisted Primary if still registered, else the first Event, else null. */
  get primary(): string | null {
    return this.#primary !== null && this.#events.has(this.#primary)
      ? this.#primary
      : (this.#events.keys().next().value ?? null);
  }
  get primaryState(): RoundState | null {
    const p = this.primary;
    return p === null ? null : (this.#events.get(p) ?? null);
  }
  /** In registration order. */
  get events(): readonly RoundState[] {
    return [...this.#events.values()];
  }
  event(tourId: string): RoundState | undefined {
    return this.#events.get(tourId);
  }
  /** Every Event's Current Round. */
  get currents(): { tourId: string; roundId: string }[] {
    return this.events.flatMap((rs) => rs.persisted().current ?? []);
  }
  get queue(): T.QueueView {
    return this.#queue;
  }
  get search(): T.SearchInfo | null {
    return this.#search;
  }

  /** That Event's Snapshot; an unknown or null tourId gives the empty one. */
  snapshot(tourId: string | null = this.primary): T.Snapshot {
    const rs = tourId === null ? undefined : this.#events.get(tourId);
    return (
      rs?.snapshot() ?? {
        events: this.summaries(),
        event: null,
        round: null,
        search: null,
        queue: structuredClone(this.#queue),
        stream: null,
      }
    );
  }

  /** Every Event as the Viewers list it, in registration order. */
  summaries(): T.EventSummary[] {
    const primary = this.primary;
    return this.events.map((rs) => {
      const round = rs.round;
      const tracked = round?.boards.filter((b) => b.tracked) ?? [];
      return {
        tourId: rs.event.tourId,
        name: rs.event.name,
        primary: rs.event.tourId === primary,
        round: round && { roundId: round.roundId, name: round.name, startsAt: round.startsAt },
        live: tracked.some((b) => b.plies.length > 1),
        tracked: tracked.length,
      };
    });
  }

  /** Register an Event (the first one becomes the Primary). An already registered tourId is returned unchanged. */
  addEvent(event: T.RegisteredEvent, topN: number): RoundState {
    const known = this.#events.get(event.tourId);
    if (known) return known;
    const first = this.primary === null;
    const rs = this.#make({ event, topN, current: null, dead: [] }, null);
    this.#events.set(event.tourId, rs);
    this.emit('event', event.tourId, { type: 'snapshot', snapshot: rs.snapshot() });
    if (first) {
      this.#primary = event.tourId;
      this.emit('primary', event.tourId); // after the snapshot: a client following the Primary gets one frame
    }
    this.#publishEvents();
    this.#saveState();
    return rs;
  }

  /** Drops the Event and its Dead-letter queue (its Round files stay: Archive). False: unknown. */
  removeEvent(tourId: string): boolean {
    const rs = this.#events.get(tourId);
    if (!rs) return false;
    const wasPrimary = this.primary === tourId;
    this.#events.delete(tourId);
    this.#retired = Promise.all([this.#retired, rs.saved()]).then(() => {});
    if (wasPrimary) {
      this.#primary = this.#events.keys().next().value ?? null;
      this.emit('primary', this.#primary); // before the empty snapshot: a client following it is rebound first
    }
    this.emit('event', tourId, { type: 'snapshot', snapshot: this.snapshot(tourId) });
    this.#publishEvents();
    this.#saveState();
    return true;
  }

  /** False: unknown Event. */
  setPrimary(tourId: string): boolean {
    if (!this.#events.has(tourId)) return false;
    if (this.primary === tourId) return true;
    this.#primary = tourId;
    this.#saveState();
    this.emit('primary', tourId);
    this.#publishEvents();
    return true;
  }

  setEngine(engine: T.EngineConfig): void {
    this.#settings = { ...this.#settings, engine };
    this.#saveState();
  }

  setJobTime(jobTimeMs: number | null): void {
    this.#settings = { ...this.#settings, jobTimeMs };
    this.#saveState();
  }

  /** The running Job's search (null: none) and the Event that Job belongs to. */
  setSearch(search: T.SearchInfo | null, tourId: string | null): void {
    this.#search = search;
    this.#searchTour = search ? tourId : null;
    this.emit('event', this.#searchTour, { type: 'search', search });
  }

  setQueue(queue: T.QueueView): void {
    this.#queue = queue;
    this.emit('event', null, { type: 'queue', queue });
  }

  /** Resolves when every state + Round save requested so far has been written (tests, shutdown). */
  async saved(): Promise<void> {
    await Promise.all([this.#stateSaving, this.#retired, ...this.events.map((rs) => rs.saved())]);
  }

  #make(entry: T.PersistedEvent, round: T.Round | null): RoundState {
    const id = entry.event.tourId;
    const live = () => this.#events.get(id) === rs;
    const host: RoundHost = {
      emit: (e, publish = true) => {
        if (!live()) return;
        this.emit('event', id, e);
        if (publish && e.type !== 'stream-status' && e.type !== 'result') this.#publishEvents();
      },
      changed: () => live() && this.#publishEvents(),
      save: () => live() && this.#saveState(),
      nextEpoch: () => ++this.#seq,
      search: () => (this.#searchTour === id ? this.#search : null),
      queue: () => this.#queue,
      summaries: () => this.summaries(),
    };
    const rs = new RoundState(this.store, host, { entry, round });
    return rs;
  }

  /** Emit the summaries (site-wide) when they differ from the last emitted ones. */
  #publishEvents(): void {
    const events = this.summaries();
    const json = JSON.stringify(events);
    if (json === this.#lastEvents) return;
    this.#lastEvents = json;
    this.emit('event', null, { type: 'events', events });
  }

  #saveState(): void {
    const state: T.PersistedState = {
      version: 3,
      settings: this.#settings,
      primary: this.primary,
      events: this.events.map((rs) => rs.persisted()),
    };
    this.#stateSaving = this.store.save(state).catch((err: unknown) => console.error('site-state: save failed', err));
  }
}
