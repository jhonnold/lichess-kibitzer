<script lang="ts">
  import { Chessground } from 'chessground';
  import type { Api } from 'chessground/api';
  import type { DrawBrush, DrawShape } from 'chessground/draw';
  import type { Dests, Key } from 'chessground/types';
  import 'chessground/assets/chessground.base.css';
  import 'chessground/assets/chessground.brown.css';
  import 'chessground/assets/chessground.cburnett.css';
  import type { ArrowSpec, ArrowStrength } from '$shared/arrows';
  import { legalDests } from '$shared/viewer';
  import type { Position } from '$lib/position';

  // Engine-line arrows: line 1 dark and opaque, alternatives pale, an inaccuracy-level one faintest. Chessground
  // rounds brush opacity to tenths. Label discs get their own fill so line 1's stands out too.
  const BRUSHES: Record<string, DrawBrush> = {
    kibBest: { key: 'kb', color: '#0b5c12', opacity: 1, lineWidth: 15 },
    kibGood: { key: 'kg', color: '#15781B', opacity: 0.5, lineWidth: 10 },
    kibInacc: { key: 'ki', color: '#15781B', opacity: 0.3, lineWidth: 8 },
  };
  const STYLE: Record<ArrowStrength, { brush: string; fill: string }> = {
    best: { brush: 'kibBest', fill: '#0b5c12' },
    good: { brush: 'kibGood', fill: '#3d7a42' },
    inaccuracy: { brush: 'kibInacc', fill: '#5f7d62' },
  };

  // With onMove: legal moves for either side (the Viewer's own exploration). Without: view only.
  type Props = { position: Position; onMove?: (from: string, to: string) => void; arrows?: ArrowSpec[] };
  const { position, onMove, arrows = [] }: Props = $props();

  let host: HTMLDivElement;
  let cg: Api | undefined;

  // Created once; chessground's own ResizeObserver follows the host's size.
  $effect(() => {
    cg = Chessground(host, {
      viewOnly: !onMove,
      animation: { enabled: !!onMove, duration: 150 }, // view-only (preview) boards snap
      movable: { free: false, color: 'both', events: { after: (from, to) => onMove?.(from, to) } },
    });
    Object.assign(cg.state.drawable.brushes, BRUSHES);
    return () => cg?.destroy();
  });
  $effect(() => {
    const { fen, turn, check, lastMove } = position;
    const dests = (onMove ? legalDests(fen) : new Map()) as Dests;
    cg?.set({ fen, turnColor: turn, check, lastMove: lastMove as Key[] | undefined, movable: { dests } });
  });
  // Fresh shape objects each run: chessground fills in label colours on them.
  $effect(() => {
    cg?.setAutoShapes(
      arrows.map(
        (a): DrawShape => ({
          orig: a.from as Key,
          dest: a.to as Key,
          brush: STYLE[a.strength].brush,
          modifiers: { lineWidth: a.rank ? Math.max(6, 11 - a.rank) : 15 },
          label: { text: a.label, fill: STYLE[a.strength].fill },
        }),
      ),
    );
  });
</script>

<div class="board" bind:this={host}></div>

<style>
  /* Arrow labels (chessground puts them in svg.cg-custom-svgs; 1px = one square): one size for every label,
     not chessground's 0.4 * 0.75^length, in a larger disc. */
  :global(.cg-wrap svg.cg-custom-svgs text) {
    font-family: var(--fontUi);
    font-size: 0.17px;
    font-weight: 700;
  }
  :global(.cg-wrap svg.cg-custom-svgs circle) {
    r: 0.34px;
  }
  .board {
    width: 100%;
    aspect-ratio: 1;
  }
</style>
