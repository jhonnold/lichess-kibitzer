import { describe, expect, it, vi } from 'vitest';
import { OPENING_MAX_PLY, OpeningFallback } from '../src/opening.js';

const moves = (n: number) => Array.from({ length: n }, (_, i) => `m${i}`);

function setup() {
  const pending: { uci: readonly string[]; resolve: (v: string | null) => void; reject: (e: unknown) => void }[] = [];
  const fetchOpening = vi.fn(
    (uci: readonly string[]) => new Promise<string | null>((resolve, reject) => pending.push({ uci, resolve, reject })),
  );
  const state = { setOpening: vi.fn() };
  const fb = new OpeningFallback(state, fetchOpening);
  const flush = () => new Promise((r) => setTimeout(r, 0));
  return { fb, state, fetchOpening, pending, flush };
}

describe('OpeningFallback', () => {
  it('looks up each new ply and sets the name', async () => {
    const { fb, state, fetchOpening, pending, flush } = setup();
    fb.seen('g1', moves(2));
    expect(fetchOpening).toHaveBeenCalledWith(moves(2));
    pending[0].resolve('C20 King');
    await flush();
    expect(state.setOpening).toHaveBeenCalledWith('g1', 'C20 King');
    fb.seen('g1', moves(2)); // same length: not again
    fb.seen('g1', moves(3));
    expect(fetchOpening).toHaveBeenCalledTimes(2);
  });

  it('skips a move that arrives while a lookup is in flight; the next one asks', async () => {
    const { fb, fetchOpening, pending, flush } = setup();
    fb.seen('g1', moves(1));
    fb.seen('g1', moves(2));
    expect(fetchOpening).toHaveBeenCalledTimes(1);
    pending[0].resolve('A00 X');
    await flush();
    fb.seen('g1', moves(3));
    expect(fetchOpening).toHaveBeenCalledTimes(2);
  });

  it('stops for a Board after null or a throw, not for others', async () => {
    const { fb, fetchOpening, pending, flush } = setup();
    fb.seen('g1', moves(1));
    fb.seen('g2', moves(1));
    pending[0].resolve(null);
    pending[1].reject(new Error('HTTP 500'));
    await flush();
    fb.seen('g1', moves(2));
    fb.seen('g2', moves(2));
    fb.seen('g3', moves(1));
    expect(fetchOpening).toHaveBeenCalledTimes(3);
  });

  it('does not ask without moves or past the ply limit', () => {
    const { fb, fetchOpening } = setup();
    fb.seen('g1', []);
    fb.seen('g1', moves(OPENING_MAX_PLY + 1));
    expect(fetchOpening).not.toHaveBeenCalled();
    fb.seen('g1', moves(OPENING_MAX_PLY));
    expect(fetchOpening).toHaveBeenCalledTimes(1);
  });

  it('clear() forgets the Round: asks again, and an old reply is dropped', async () => {
    const { fb, state, fetchOpening, pending, flush } = setup();
    fb.seen('g1', moves(2));
    fb.clear();
    fb.seen('g1', moves(2));
    expect(fetchOpening).toHaveBeenCalledTimes(2);
    pending[0].resolve('OLD');
    await flush();
    expect(state.setOpening).not.toHaveBeenCalled();
    pending[1].resolve('NEW');
    await flush();
    expect(state.setOpening).toHaveBeenCalledWith('g1', 'NEW');
  });
});
