<script lang="ts">
  import { MARK_GLYPH } from '$shared/analysis';
  import type { Mark } from '$shared/accuracy';
  import type { Ply } from '$shared/types';

  type Props = { plies: Ply[]; marks: (Mark | null)[]; cursor: number; follow: boolean; onJump: (ply: number) => void };
  const { plies, marks, cursor, follow, onJump }: Props = $props();

  // rows[n] = [index of White's move, index of Black's move] for full move n + 1
  const rows = $derived(
    Array.from({ length: Math.ceil((plies.length - 1) / 2) }, (_, n) =>
      [2 * n + 1, 2 * n + 2].filter((i) => i < plies.length),
    ),
  );

  let list: HTMLOListElement;
  $effect(() => {
    void plies.length;
    void cursor;
    if (follow)
      list.scrollTop = list.scrollHeight; // follow the latest move
    else if (cursor === 0) list.scrollTop = 0;
    else list.querySelector('.cur')?.scrollIntoView({ block: 'nearest' }); // keep the stepped-to move visible
  });
</script>

<div class="wrap">
  <ol bind:this={list}>
    {#each rows as row, n (n)}
      <li>
        <span class="num">{n + 1}.</span>
        {#each row as i (i)}
          {@const mark = marks[i]}
          <button type="button" class="move" class:cur={i === cursor} onclick={() => onJump(i)}>
            {plies[i].move!.san}{#if mark}<span class={mark}>{MARK_GLYPH[mark]}</span>{/if}
          </button>
        {/each}
      </li>
    {/each}
  </ol>
</div>

<style>
  .wrap {
    display: flex;
    flex: 1 1 0;
    flex-direction: column;
    min-height: 0;
    container-type: inline-size;
  }
  ol {
    flex: 1 1 0;
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    align-content: start;
    column-gap: 8px;
    min-height: 0;
    margin: 0;
    padding: 0 8px 8px;
    overflow-y: auto;
    list-style: none;
    font: 400 14px var(--fontMono);
  }
  /* Wide card: two full moves per row. */
  @container (min-width: 380px) {
    ol {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
  }
  li {
    display: grid;
    grid-template-columns: 32px minmax(0, 1fr) minmax(0, 1fr);
    align-items: center;
    min-height: 28px;
  }
  .num {
    padding-right: 8px;
    color: var(--dim);
    text-align: right;
  }
  .move {
    padding: 2px 8px;
    border: 0;
    border-radius: 4px;
    font: inherit;
    color: inherit;
    text-align: left;
    background: none;
    cursor: pointer;
  }
  .move:hover {
    background: var(--surface3);
  }
  .cur,
  .cur:hover {
    background: var(--accentPill);
    color: var(--text);
    font-weight: 600;
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
</style>
