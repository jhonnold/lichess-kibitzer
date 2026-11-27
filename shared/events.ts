import { DEFAULT_TOP_N } from './types.js';

/** Default Tracked boards of a newly added Event: DEFAULT_TOP_N shared by the registered Events, the new one counted. */
export const defaultTopN = (events: number): number => Math.max(1, Math.floor(DEFAULT_TOP_N / Math.max(1, events)));
