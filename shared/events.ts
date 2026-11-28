import { ARCHIVE_HASH, roundHash } from './route.js';
import { DEFAULT_TOP_N, type EventSummary, type Snapshot } from './types.js';

/** Default Tracked boards of a newly added Event: DEFAULT_TOP_N shared by the registered Events, the new one counted. */
export const defaultTopN = (events: number): number => Math.max(1, Math.floor(DEFAULT_TOP_N / Math.max(1, events)));

/** A route's tourId the server does not follow (deep link to an unknown or removed Event). False until a snapshot. */
export const unknownTour = (snap: Snapshot | null, tourId: string | null): boolean =>
  tourId !== null && !!snap && !snap.events.some((e) => e.tourId === tourId);

/** One Event on the Events page. */
export interface EventCard {
  tourId: string;
  name: string;
  href: string; // the Event's overview (next, finished: the Archive); the caller appends the streaming params
  // live: a Tracked Board has a move; upcoming: a Round, not live. No Current Round: next: waiting for the next Round;
  // finished: every Round finished; idle: no Rounds yet, or not polled yet (`polled` false)
  state: 'live' | 'upcoming' | 'next' | 'finished' | 'idle';
  round: string | null; // Current Round name
  startsAt: number | null; // upcoming only (for the countdown)
  next: { name: string; startsAt: number | null } | null; // state next only
  polled: boolean;
  tracked: number;
  primary: boolean; // the Event the old `#/board/n` URLs follow
}

const stateOf = (e: EventSummary): EventCard['state'] =>
  e.live ? 'live' : e.round ? 'upcoming' : e.next ? 'next' : e.finished ? 'finished' : 'idle';

export const eventCards = (events: readonly EventSummary[]): EventCard[] =>
  events.map((e) => {
    const state = stateOf(e);
    return {
      tourId: e.tourId,
      name: e.name,
      href: state === 'next' || state === 'finished' ? ARCHIVE_HASH : roundHash(e.tourId),
      state,
      round: e.round?.name ?? null,
      startsAt: !e.live && e.round ? e.round.startsAt : null,
      next: state === 'next' ? e.next! : null,
      polled: e.finished !== undefined,
      tracked: e.tracked,
      primary: e.primary,
    };
  });
