import { roundHash } from './route.js';
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
  href: string; // the Event's overview; the caller appends the streaming params
  state: 'live' | 'upcoming' | 'idle'; // live: a Board has a move; upcoming: a Round, not live; idle: no Round
  round: string | null; // Current Round name
  startsAt: number | null; // upcoming only (for the countdown)
  tracked: number;
  primary: boolean; // the Event the old `#/board/n` URLs follow
}

export const eventCards = (events: readonly EventSummary[]): EventCard[] =>
  events.map((e) => ({
    tourId: e.tourId,
    name: e.name,
    href: roundHash(e.tourId),
    state: e.live ? 'live' : e.round ? 'upcoming' : 'idle',
    round: e.round?.name ?? null,
    startsAt: !e.live && e.round ? e.round.startsAt : null,
    tracked: e.tracked,
    primary: e.primary,
  }));
