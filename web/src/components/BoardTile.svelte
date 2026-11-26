<script lang="ts">
  import { MARK_GLYPH } from '$shared/analysis';
  import { tileView } from '$shared/overview';
  import type { Board as BoardData, QueueView, SearchInfo } from '$shared/types';
  import { archivedResult, barScore, shortName, statusLine, tickingClock, type JobState } from '$shared/viewer';
  import { formatClock } from '$lib/format';
  import Board from './Board.svelte';
  import EvalBar from './EvalBar.svelte';

  // now: server ms (the clock of the side to move of a Live Board ticks).
  // href: where a tile links; archived: no Queue dot, no "to move", Boards without a result read unfinished/not played.
  type Props = {
    board: BoardData;
    search: SearchInfo | null;
    queue: QueueView;
    href?: (n: number) => string;
    archived?: boolean;
    now: number;
  };
  const { board, search, queue, href, archived = false, now }: Props = $props();

  // Re-derived only when this Board changes (applyEvent keeps untouched Boards' identity).
  const t = $derived(tileView(board, href));
  const latest = $derived(board.plies.length - 1);
  const bar = $derived(barScore(board, latest, search));
  const dot = $derived(statusLine(board, latest, search, queue));
  const QUEUE: Record<JobState, string> = { searching: 'Analysing', queued: 'Queued', done: 'Up to date', none: '' };
  const state = $derived(
    archived ? archivedResult(board) : t.state === 'live' ? 'LIVE' : t.state === 'upcoming' ? 'UPCOMING' : t.result,
  );
</script>

{#snippet row(color: 'white' | 'black')}
  {@const p = t[color]}
  <div class="player">
    {#if p.title}<span class="title">{p.title}</span>{/if}
    <span class="name" title={p.name}>{shortName(p.name)}</span>
    {#if p.rating}<span class="muted">{p.rating}</span>{/if}
    <span class="clock" class:toMove={!archived && t.toMove === color}>
      {formatClock(tickingClock(board, color, !archived && t.state === 'live', now))}
    </span>
  </div>
{/snippet}

<a href={t.href} class="tile">
  <div class="top">
    <span class="n">{t.board}</span>
    {#if state}<span class="state" class:live={!archived && t.state === 'live'}>{state}</span>{/if}
    {#if t.mark}<span class="mark {t.mark}" title={t.mark}>{MARK_GLYPH[t.mark]}</span>{/if}
    {#if !archived && QUEUE[dot.state]}
      <span class="queue" title={dot.text}><i class={dot.state}></i>{QUEUE[dot.state]}</span>
    {/if}
  </div>
  {@render row('black')}
  <div class="mid">
    <EvalBar score={bar.score} dim={bar.dim} />
    <Board position={t.position} coordinates={false} />
  </div>
  {@render row('white')}
</a>

<style>
  .tile {
    display: flex;
    flex-direction: column;
    gap: 6px;
    min-width: 0;
    padding: 10px 10px 12px;
    border: 1px solid var(--surface3);
    border-radius: 10px;
    background: var(--surface2);
    color: var(--text);
    text-decoration: none;
  }
  .tile:hover {
    border-color: var(--accent);
  }
  .top {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 24px;
  }
  .n {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 24px;
    height: 22px;
    padding: 0 6px;
    border-radius: 5px;
    background: var(--surface3);
    font: 600 12px var(--fontMono);
  }
  .state {
    padding: 1px 8px;
    border-radius: 999px;
    background: var(--surface3);
    color: var(--text2);
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.04em;
  }
  .state.live {
    background: var(--liveBg);
    color: var(--liveText);
  }
  .queue {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    margin-left: auto;
    color: var(--muted);
    font-size: 12px;
  }
  i {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--muted);
  }
  i.searching {
    background: var(--accent);
  }
  i.queued {
    background: var(--warn);
  }
  .mid {
    display: flex;
    gap: 6px;
  }
  .mid :global(.bar) {
    width: 8px;
    flex: none;
    border-radius: 3px;
  }
  .mid :global(.bar span) {
    display: none; /* the score label does not fit in 8 px */
  }
  .mid :global(.board) {
    flex: 1;
    min-width: 0;
  }
  .player {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
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
    font-size: 13px;
    font-weight: 700;
  }
  .muted {
    color: var(--muted);
    font-size: 12px;
  }
  .clock {
    margin-left: auto;
    padding: 1px 7px;
    border-radius: 4px;
    background: var(--surface);
    font: 600 15px var(--fontMono);
  }
  .clock.toMove {
    background: var(--evalW);
    color: var(--onLight);
  }
  .mark {
    font-weight: 700;
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
  @media (max-width: 699px) {
    .tile {
      gap: 4px;
      padding: 6px 6px 8px;
    }
    .top {
      gap: 6px;
    }
    .queue {
      font-size: 0; /* dot only */
    }
    .muted {
      display: none;
    }
    .player {
      font-size: 13px;
    }
    .clock {
      padding: 0 5px;
      font-size: 13px;
    }
  }
</style>
