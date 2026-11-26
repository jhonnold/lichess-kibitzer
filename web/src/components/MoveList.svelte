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

<style>
  ol {
    flex: 1;
    min-height: 0;
    margin: 0;
    padding: 8px 12px;
    overflow-y: auto;
    list-style: none;
    font-family: var(--fontMono);
  }
  li {
    display: grid;
    grid-template-columns: 3em 7em 7em;
    line-height: 1.8;
  }
  .num {
    color: var(--muted);
  }
  .move {
    padding: 0;
    border: 0;
    font: inherit;
    color: inherit;
    text-align: left;
    background: none;
    cursor: pointer;
  }
  .cur {
    color: var(--accent);
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
</style>
