<script lang="ts">
  import type { Color } from '$shared/accuracy';
  import type { Player } from '$shared/types';
  import { PIECE_GLYPH, type MaterialSide } from '$shared/material';
  import { formatClock } from '$lib/format';

  type Props = {
    player: Player;
    color: Color;
    clock: number | null;
    accuracy: number | null;
    toMove: boolean;
    material: MaterialSide;
  };
  const { player, color, clock, accuracy, toMove, material }: Props = $props();
</script>

<div class="player">
  <span class="side {color}" aria-label={color === 'white' ? 'White' : 'Black'}></span>
  {#if player.title}<span class="title">{player.title}</span>{/if}
  <span class="name" title={player.name}>{player.name}</span>
  {#if player.rating}<span class="muted">{player.rating}</span>{/if}
  {#if material.pieces.length}
    <span class="material" title="Material">
      {material.pieces.map((r) => PIECE_GLYPH[r]).join('')}{#if material.diff > 0}<b>+{material.diff}</b>{/if}
    </span>
  {/if}
  {#if accuracy !== null}<span class="acc" title="Accuracy">{Math.round(accuracy)}% acc</span>{/if}
  <span class="clock" class:toMove>{formatClock(clock)}</span>
</div>

<style>
  .player {
    display: flex;
    align-items: center;
    gap: 10px;
    height: var(--barH);
    min-width: 0;
  }
  .player > :not(.name) {
    flex: none;
  }
  .side {
    width: 12px;
    height: 12px;
    border: 1px solid var(--dim);
    border-radius: 3px;
  }
  .side.white {
    background: var(--evalW);
  }
  .side.black {
    background: var(--bg);
  }
  .title {
    color: var(--accent);
    font-weight: 700;
  }
  .name {
    min-width: 0;
    overflow: hidden;
    font-size: 16px;
    font-weight: 600;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .muted {
    color: var(--muted);
  }
  .material {
    color: var(--muted);
    letter-spacing: 1px;
  }
  .material b {
    margin-left: 4px;
    font: 600 12px var(--fontMono);
  }
  .acc {
    padding: 2px 8px;
    border-radius: 999px;
    background: var(--surface);
    color: var(--text2);
    font-size: 12px;
    font-weight: 600;
  }
  .clock {
    margin-left: auto;
    padding: 4px 12px;
    border-radius: var(--radiusS);
    background: var(--surface);
    font: 600 24px var(--fontMono);
    letter-spacing: -0.02em;
  }
  .clock.toMove {
    background: var(--evalW);
    color: var(--onLight);
  }
  @media (max-width: 699px) {
    .player {
      gap: 8px;
      height: 40px;
    }
    .name {
      font-size: 15px;
    }
    .acc {
      display: none;
    }
    .clock {
      padding: 2px 8px;
      font-size: 20px;
    }
  }
</style>
