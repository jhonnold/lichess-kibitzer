<script lang="ts">
  import { MARK_GLYPH } from '$shared/analysis';
  import { tileView } from '$shared/overview';
  import type { Board as BoardData, QueueView, SearchInfo } from '$shared/types';
  import { archivedResult, barScore, shortName, statusLine } from '$shared/viewer';
  import { formatClock } from '$lib/format';
  import Board from './Board.svelte';
  import EvalBar from './EvalBar.svelte';

  // href: where a tile links; archived: no Queue dot, no "to move", Boards without a result read unfinished/not played.
  type Props = {
    board: BoardData;
    search: SearchInfo | null;
    queue: QueueView;
    href?: (n: number) => string;
    archived?: boolean;
  };
  const { board, search, queue, href, archived = false }: Props = $props();

  // Re-derived only when this Board changes (applyEvent keeps untouched Boards' identity).
  const t = $derived(tileView(board, href));
  const latest = $derived(board.plies.length - 1);
  const bar = $derived(barScore(board, latest, search));
  const dot = $derived(statusLine(board, latest, search, queue));
</script>

{#snippet row(color: 'white' | 'black')}
  {@const p = t[color]}
  <div class="player">
    {#if p.title}<span class="title">{p.title}</span>{/if}
    <span class="name" title={p.name}>{shortName(p.name)}</span>
    {#if p.rating}<span class="muted">{p.rating}</span>{/if}
    <span class="clock" class:toMove={!archived && t.toMove === color}>{formatClock(t.clocks[color])}</span>
  </div>
{/snippet}

<a href={t.href} class="tile">
  {@render row('black')}
  <div class="mid">
    <EvalBar score={bar.score} dim={bar.dim} />
    <Board position={t.position} coordinates={false} />
  </div>
  {@render row('white')}
  <div class="foot">
    <b>{t.board}</b>
    {#if t.mark}<span class={t.mark}>{MARK_GLYPH[t.mark]}</span>{/if}
    <span class="muted">
      {archived ? archivedResult(board) : (t.result ?? (t.state === 'upcoming' ? 'upcoming' : ''))}
    </span>
    {#if !archived}<span class="dot {dot.state}" title={dot.text} aria-label={dot.text}></span>{/if}
  </div>
</a>

<style>
  .tile {
    display: flex;
    flex-direction: column;
    gap: 3px;
    min-width: 0;
    padding: 4px;
    color: var(--text);
    text-decoration: none;
    background: var(--surface2);
  }
  .tile:hover {
    outline: 1px solid var(--accent);
  }
  .mid {
    display: flex;
    gap: 6px;
  }
  .mid :global(.bar) {
    width: 18px;
    flex: none;
  }
  .mid :global(.bar span) {
    display: none; /* the score label does not fit in 18 px */
  }
  .mid :global(.board) {
    flex: 1;
  }
  .player {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    font-size: 15px;
    line-height: 1.3;
  }
  .name {
    min-width: 0;
    overflow: hidden;
    font-weight: 600;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .title {
    color: var(--accent);
    font-weight: 700;
  }
  .muted {
    color: var(--muted);
    font-size: 13px;
  }
  .clock {
    margin-left: auto;
    padding: 0 6px;
    font: 600 16px var(--fontMono);
    background: var(--surface);
  }
  .clock.toMove {
    color: var(--accent);
  }
  .foot {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 14px;
  }
  .foot .muted {
    flex: 1;
  }
  .inaccuracy {
    color: var(--inaccuracy);
  }
  .mistake {
    color: var(--mistake);
  }
  .blunder {
    color: var(--blunder);
  }
  .dot {
    width: 10px;
    height: 10px;
    border-radius: 50%;
  }
  .dot.searching {
    background: var(--accent);
  }
  .dot.queued {
    background: var(--warn);
  }
  .dot.done {
    background: var(--muted);
  }
  .dot.none {
    visibility: hidden;
  }
</style>
