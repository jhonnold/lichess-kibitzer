<script lang="ts">
  import { MARK_GLYPH, latestMark } from '$shared/analysis';
  import type { ArchiveCtx } from '$shared/archive';
  import { ARCHIVE_HASH, archiveHash, boardHash, ROUND_HASH } from '$shared/route';
  import type { Board } from '$shared/types';
  import { archivedResult, boardState, formatResult, shortName } from '$shared/viewer';

  type Props = { boards: Board[]; selected: number; ctx?: ArchiveCtx | null; onFlip?: () => void };
  const { boards, selected, ctx = null, onFlip }: Props = $props();
  const href = (n: number) => (ctx ? archiveHash(ctx.tourId, ctx.roundId, n) : boardHash(n));
</script>

<div class="links">
  {#if ctx}
    <a href={archiveHash(ctx.tourId, ctx.roundId)}>Overview (o)</a>
    <a href={ARCHIVE_HASH}>All Rounds</a>
    <a href="#/">Back to live</a>
  {:else}
    <a href={ROUND_HASH}>Overview (o)</a>
    <a href={ARCHIVE_HASH}>Archive</a>
  {/if}
  {#if onFlip}<button class="link" onclick={onFlip}>Flip board (f)</button>{/if}
</div>
<nav>
  {#each boards as b (b.id)}
    {@const st = boardState(b)}
    {@const mark = latestMark(b.plies)}
    <a href={href(b.board)} aria-current={b.board === selected ? 'page' : undefined}>
      <span class="names"><b>{b.board}</b> {shortName(b.white.name)} – {shortName(b.black.name)}</span>
      {#if mark}<span class={mark}>{MARK_GLYPH[mark]}</span>{/if}
      {#if ctx}
        <span class="state">{archivedResult(b)}</span>
      {:else if st === 'finished'}
        <span class="state">{formatResult(b.result)}</span>
      {:else if st === 'live'}
        <span class="state live">● live</span>
      {:else}
        <span class="state">upcoming</span>
      {/if}
    </a>
  {/each}
</nav>

<style>
  .links {
    display: flex;
    justify-content: flex-end;
    gap: 12px;
    padding: 4px 8px 0;
    font-size: 14px;
    background: var(--surface);
  }
  .links a,
  .links .link {
    color: var(--accent);
  }
  .links .link {
    padding: 0;
    border: 0;
    font: inherit;
    background: none;
    cursor: pointer;
  }
  nav {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(250px, 1fr));
    gap: 4px;
    padding: 6px;
    background: var(--surface);
  }
  nav a {
    display: flex;
    gap: 8px;
    min-width: 0;
    padding: 3px 8px;
    border: 1px solid var(--line);
    font-size: 14px;
    line-height: 1.25;
    color: var(--text);
    text-decoration: none;
    background: var(--surface2);
  }
  nav a[aria-current='page'] {
    border-color: var(--accent);
    background: var(--bg);
  }
  .names {
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .state {
    flex: none;
    margin-left: auto;
    color: var(--muted);
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
  .live {
    color: var(--blunder);
  }
</style>
