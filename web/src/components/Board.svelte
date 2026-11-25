<script lang="ts">
  import { Chessground } from 'chessground';
  import type { Api } from 'chessground/api';
  import 'chessground/assets/chessground.base.css';
  import 'chessground/assets/chessground.brown.css';
  import 'chessground/assets/chessground.cburnett.css';
  import type { Position } from '$lib/position';

  type Props = { position: Position };
  const { position }: Props = $props();

  let host: HTMLDivElement;
  let cg: Api | undefined;

  // View-only in this layer. Created once; chessground's own ResizeObserver follows the host's size.
  $effect(() => {
    cg = Chessground(host, { viewOnly: true, animation: { duration: 150 } });
    return () => cg?.destroy();
  });
  $effect(() => {
    const { fen, turn, check, lastMove } = position;
    cg?.set({ fen, turnColor: turn, check, lastMove });
  });
</script>

<div class="board" bind:this={host}></div>

<style>
  .board {
    width: 100%;
    aspect-ratio: 1;
  }
</style>
