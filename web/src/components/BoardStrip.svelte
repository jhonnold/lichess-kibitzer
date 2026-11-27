<script lang="ts">
  import { MARK_GLYPH, latestMark } from '$shared/analysis';
  import type { ArchiveCtx } from '$shared/archive';
  import { archiveHash, boardHash } from '$shared/route';
  import type { Board } from '$shared/types';
  import { archivedResult, boardState, formatResult, shortName } from '$shared/viewer';

  type Props = { boards: Board[]; selected: number; ctx?: ArchiveCtx | null; query?: string; tourId?: string | null };
  const { boards, selected, ctx = null, query = '', tourId = null }: Props = $props();
  const href = (n: number) => (ctx ? archiveHash(ctx.tourId, ctx.roundId, n) : boardHash(n, undefined, tourId)) + query;
  // Every Board: the Tracked ones first, then the others (dimmed, unless none is Tracked: an imported Round), each part
  // in board order.
  const ordered = $derived([...boards.filter((b) => b.tracked), ...boards.filter((b) => !b.tracked)]);
  const dim = $derived(boards.some((b) => b.tracked));

  // Keep the selected Board in view inside the strip (it scrolls; the page around it does not move).
  let nav = $state<HTMLElement>();
  $effect(() => {
    void selected;
    const a = nav?.querySelector<HTMLElement>('[aria-current]');
    if (!nav || !a) return;
    const [n, r] = [nav.getBoundingClientRect(), a.getBoundingClientRect()];
    if (r.top < n.top || r.bottom > n.bottom) nav.scrollTop += r.top - n.top;
    if (r.left < n.left || r.right > n.right) nav.scrollLeft += r.left - n.left - 16;
  });
</script>

<nav aria-label="Boards" bind:this={nav}>
  {#each ordered as b (b.id)}
    {@const st = boardState(b)}
    {@const mark = latestMark(b.plies)}
    <a
      href={href(b.board)}
      class:untracked={dim && !b.tracked}
      title={b.tracked ? undefined : 'Not analysed'}
      aria-current={b.board === selected ? 'page' : undefined}
    >
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
  /* Desktop: wraps, at most two rows, then scrolls (a Round can have 100+ Boards). */
  nav {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    min-width: 0;
    max-height: calc(2 * 32px + 6px);
    overflow-y: auto;
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
  a.untracked:not([aria-current='page']) {
    border-style: dashed;
    background: none;
    color: var(--text2);
    opacity: 0.7;
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
      max-height: none;
      overflow-x: auto;
      overflow-y: hidden;
      scrollbar-width: none;
    }
    a {
      flex: none;
      min-height: 36px;
    }
  }
</style>
