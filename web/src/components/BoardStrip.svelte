<script lang="ts">
  import { boardHash } from '$shared/route';
  import type { Board } from '$shared/types';
  import { boardState, formatResult, shortName } from '$shared/viewer';

  type Props = { boards: Board[]; selected: number };
  const { boards, selected }: Props = $props();
</script>

<nav>
  {#each boards as b (b.id)}
    {@const st = boardState(b)}
    <a href={boardHash(b.board)} aria-current={b.board === selected ? 'page' : undefined}>
      <span class="names"><b>{b.board}</b> {shortName(b.white.name)} – {shortName(b.black.name)}</span>
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
  nav {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(250px, 1fr));
    gap: 4px;
    padding: 6px;
    background: var(--surface);
  }
  a {
    display: flex;
    justify-content: space-between;
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
  a[aria-current='page'] {
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
    color: var(--muted);
  }
  .live {
    color: var(--blunder);
  }
</style>
