import { Router, type Response } from 'express';
import { archiveIndex, isLichessId } from '../../shared/archive.js';
import type { RoundState } from '../round-state.js';
import type { DataStore } from '../store.js';

export interface ArchiveDeps {
  store: Pick<DataStore, 'listRounds' | 'loadRound'>;
  state: Pick<RoundState, 'round'>;
}

const notFound = (res: Response) => res.status(404).json({ error: 'not found' });

/** Public, read-only: the Archive = every stored Round except the Current Round (still changing). */
export function archiveRouter({ store, state }: ArchiveDeps): Router {
  const router = Router();
  const fail = (res: Response, err: unknown) => {
    console.error('archive read failed:', err);
    res.status(500).json({ error: 'archive read failed' });
  };
  router.get('/api/archive', async (_req, res) => {
    try {
      const { round } = state;
      const events = archiveIndex(await store.listRounds(), round && { tourId: round.tourId, roundId: round.roundId });
      res.set('Cache-Control', 'no-cache').json(events);
    } catch (err) {
      fail(res, err);
    }
  });
  router.get('/api/archive/:tourId/:roundId', async (req, res) => {
    const { tourId, roundId } = req.params; // decoded by Express: `..%2f` arrives as `../`
    const cur = state.round;
    if (!isLichessId(tourId) || !isLichessId(roundId) || (cur?.tourId === tourId && cur.roundId === roundId)) {
      notFound(res);
      return;
    }
    try {
      const round = await store.loadRound(tourId, roundId);
      if (!round) {
        notFound(res);
        return;
      }
      // Not immutable: re-registering the Event can re-open an archived Round and write it again.
      res.set('Cache-Control', 'public, max-age=300').json({ ...round, boards: round.boards.filter((b) => b.tracked) });
    } catch (err) {
      fail(res, err);
    }
  });
  return router;
}
