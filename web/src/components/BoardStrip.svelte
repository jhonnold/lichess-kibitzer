<script lang="ts">
  import { MARK_GLYPH, latestMark } from '$shared/analysis';
  import type { ArchiveCtx } from '$shared/archive';
  import { archiveHash, boardHash } from '$shared/route';
  import type { Board } from '$shared/types';
  import { archivedResult, boardState, formatResult, shortName } from '$shared/viewer';

  type Props = { boards: Board[]; selected: number; ctx?: ArchiveCtx | null; query?: string; tourId?: string | null };
  const { boards, selected, ctx = null, query = '', tourId = null }: Props = $props();
  const href = (n: number) => (ctx ? archiveHash(ctx.tourId, ctx.roundId, n) : boardHash(n, undefined, tourId)) + query;
</script>

<nav aria-label="Tracked boards">
  {#each boards as b (b.id)}
    {@const st = boardState(b)}
    {@const mark = latestMark(b.plies)}
    <a href={href(b.board)} aria-current={b.board === selected ? 'page' : undefined}>
      <b>{b.board}</b>
      <span class="names">{shortName(b.white.name)} – {shortName(b.black.name)}</span>
      {#if mark}<span class={mark}>{MARK_GLYPH[mark]}</span>{/if}
      {#if ctx}
        <span class="state">{archivedResult(b)}</span>
      {:else if st === 'finished'}
        <span class="state">{formatResult(b.result)}</span>
      {:else if st === 'live'}
        <span class="dot" title="Live" aria-label="Live"></span>
      {:else}
        <span class="state">upcoming</span>
      {/if}
    </a>
  {/each}
</nav>

<style>
  nav {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    min-width: 0;
  }
  a {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
    min-height: 32px;
    padding: 0 12px;
    border: 1px solid var(--line);
    border-radius: var(--radiusS);
    background: var(--surface2);
    color: var(--text);
    font-size: 13px;
    text-decoration: none;
    white-space: nowrap;
  }
  a:hover {
    border-color: var(--muted);
  }
  a[aria-current='page'] {
    border-color: var(--accent);
    background: var(--accentBg);
  }
  b {
    font-family: var(--fontMono);
    color: var(--accent);
  }
  .names {
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .state {
    flex: none;
    color: var(--muted);
  }
  .dot {
    flex: none;
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--live);
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
  /* Below desktop: one row that scrolls sideways. */
  @media (max-width: 1099px) {
    nav {
      flex-wrap: nowrap;
      overflow-x: auto;
      scrollbar-width: none;
    }
    a {
      flex: none;
      min-height: 36px;
    }
  }
</style>
