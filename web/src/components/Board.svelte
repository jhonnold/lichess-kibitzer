<script lang="ts">
  import { Chessground } from 'chessground';
  import type { Api } from 'chessground/api';
  import type { Dests, Key } from 'chessground/types';
  import 'chessground/assets/chessground.base.css';
  import 'chessground/assets/chessground.brown.css';
  import 'chessground/assets/chessground.cburnett.css';
  import { legalDests } from '$shared/viewer';
  import type { Position } from '$lib/position';

  // With onMove: legal moves for either side (the Viewer's own exploration). Without: view only.
  type Props = { position: Position; onMove?: (from: string, to: string) => void };
  const { position, onMove }: Props = $props();

  let host: HTMLDivElement;
  let cg: Api | undefined;

  // Created once; chessground's own ResizeObserver follows the host's size.
  $effect(() => {
    cg = Chessground(host, {
      viewOnly: !onMove,
      animation: { enabled: !!onMove, duration: 150 }, // view-only (preview) boards snap
      movable: { free: false, color: 'both', events: { after: (from, to) => onMove?.(from, to) } },
    });
    return () => cg?.destroy();
  });
  $effect(() => {
    const { fen, turn, check, lastMove } = position;
    const dests = (onMove ? legalDests(fen) : new Map()) as Dests;
    cg?.set({ fen, turnColor: turn, check, lastMove: lastMove as Key[] | undefined, movable: { dests } });
  });
</script>

<div class="board" bind:this={host}></div>

<style>
  .board {
    width: 100%;
    aspect-ratio: 1;
  }
</style>
