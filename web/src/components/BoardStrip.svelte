<script lang="ts">
  import { MARK_GLYPH, latestMark } from '$shared/analysis';
  import { boardHash, ROUND_HASH } from '$shared/route';
  import type { Board } from '$shared/types';
  import { boardState, formatResult, shortName } from '$shared/viewer';

  type Props = { boards: Board[]; selected: number };
  const { boards, selected }: Props = $props();
</script>

<a class="overview" href={ROUND_HASH}>Overview (o)</a>
<nav>
  {#each boards as b (b.id)}
    {@const st = boardState(b)}
    {@const mark = latestMark(b.plies)}
    <a href={boardHash(b.board)} aria-current={b.board === selected ? 'page' : undefined}>
      <span class="names"><b>{b.board}</b> {shortName(b.white.name)} – {shortName(b.black.name)}</span>
      {#if mark}<span class={mark}>{MARK_GLYPH[mark]}</span>{/if}
      {#if st === 'finished'}
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
  .overview {
    padding: 4px 8px 0;
    font-size: 14px;
    text-align: right;
    color: var(--accent);
    background: var(--surface);
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
