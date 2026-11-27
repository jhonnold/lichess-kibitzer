import { DEFAULT_TOP_N, type Snapshot } from './types.js';

/** Default Tracked boards of a newly added Event: DEFAULT_TOP_N shared by the registered Events, the new one counted. */
export const defaultTopN = (events: number): number => Math.max(1, Math.floor(DEFAULT_TOP_N / Math.max(1, events)));

/** A route's tourId the server does not follow (deep link to an unknown or removed Event). False until a snapshot. */
export const unknownTour = (snap: Snapshot | null, tourId: string | null): boolean =>
  tourId !== null && !!snap && !snap.events.some((e) => e.tourId === tourId);
