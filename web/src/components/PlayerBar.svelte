<script lang="ts">
  import type { Player } from '$shared/types';
  import { PIECE_GLYPH, type MaterialSide } from '$shared/material';
  import { formatClock } from '$lib/format';

  type Props = {
    player: Player;
    clock: number | null;
    accuracy: number | null;
    toMove: boolean;
    material: MaterialSide;
  };
  const { player, clock, accuracy, toMove, material }: Props = $props();
</script>

<div class="player">
  {#if player.title}<span class="title">{player.title}</span>{/if}
  <span class="name">{player.name}</span>
  {#if player.rating}<span class="muted">{player.rating}</span>{/if}
  {#if material.pieces.length}
    <span class="material" title="Material">
      {material.pieces.map((r) => PIECE_GLYPH[r]).join('')}{#if material.diff > 0}<b>+{material.diff}</b>{/if}
    </span>
  {/if}
  {#if accuracy !== null}<span class="muted">{Math.round(accuracy)}% accuracy</span>{/if}
  <span class="clock" class:toMove>{formatClock(clock)}</span>
</div>

<style>
  .player {
    display: flex;
    align-items: center;
    gap: 10px;
    height: var(--barH);
    font-size: 20px;
  }
  .title {
    color: var(--accent);
    font-weight: 700;
  }
  .name {
    font-weight: 600;
  }
  .muted {
    color: var(--muted);
    font-size: 16px;
  }
  .material {
    color: var(--muted);
    font-size: 16px;
    letter-spacing: 1px;
  }
  .material b {
    margin-left: 4px;
    font-family: var(--fontMono);
    font-size: 14px;
  }
  .clock {
    margin-left: auto;
    padding: 2px 10px;
    font: 600 24px var(--fontMono);
    background: var(--surface);
  }
  .clock.toMove {
    background: var(--surface2);
    color: var(--accent);
  }
</style>
