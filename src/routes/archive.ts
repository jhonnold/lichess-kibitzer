import { Router, type Response } from 'express';
import { archiveIndex, isLichessId } from '../../shared/archive.js';
import { archiveReads } from '../metrics.js';
import type { SiteState } from '../site-state.js';
import type { DataStore } from '../store.js';

export interface ArchiveDeps {
  store: Pick<DataStore, 'listRounds' | 'loadRound'>;
  state: Pick<SiteState, 'currents'> & { archive: Pick<SiteState['archive'], 'saved'> };
}

const notFound = (res: Response) => res.status(404).json({ error: 'not found' });

/** Public, read-only: the Archive = every stored Round except the Current Round of each Event (still changing). */
export function archiveRouter({ store, state }: ArchiveDeps): Router {
  const router = Router();
  const fail = (res: Response, err: unknown) => {
    archiveReads.inc({ outcome: 'error' });
    console.error('archive read failed:', err);
    res.status(500).json({ error: 'archive read failed' });
  };
  router.get('/api/archive', async (_req, res) => {
    try {
      const events = archiveIndex(await store.listRounds(), state.currents);
      archiveReads.inc({ outcome: 'ok' });
      res.set('Cache-Control', 'no-cache').json(events);
    } catch (err) {
      fail(res, err);
    }
  });
  router.get('/api/archive/:tourId/:roundId', async (req, res) => {
    const { tourId, roundId } = req.params; // decoded by Express: `..%2f` arrives as `../`
    if (
      !isLichessId(tourId) ||
      !isLichessId(roundId) ||
      state.currents.some((c) => c.tourId === tourId && c.roundId === roundId)
    ) {
      notFound(res);
      return;
    }
    try {
      await state.archive.saved(); // a deep eval just recorded (its request may have just ended) is in the file
      const round = await store.loadRound(tourId, roundId);
      archiveReads.inc({ outcome: 'ok' });
      if (!round) {
        notFound(res);
        return;
      }
      // Not immutable: re-registering the Event can re-open an archived Round, and deep analysis writes it again.
      res.set('Cache-Control', 'no-cache').json(round);
    } catch (err) {
      fail(res, err);
    }
  });
  return router;
}
