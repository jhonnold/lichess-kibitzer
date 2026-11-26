<script lang="ts">
  import { play, type PanelInfo } from '$shared/viewer';
  import { formatLine, formatNps, formatScore } from '$lib/format';
  import Board from './Board.svelte';

  // fen: the position at info.ply, which the lines are played from.
  type Props = { info: PanelInfo | null; fen: string };
  const { info, fen }: Props = $props();

  let hovered = $state<number | null>(null);
  const pv = $derived(hovered === null ? undefined : info?.lines[hovered]?.san);
  const preview = $derived.by(() => {
    try {
      return pv && play(fen, pv);
    } catch {
      return undefined; // a line that doesn't fit the board (stale after a move upsert): no preview
    }
  });
  const meta = $derived(
    info
      ? [
          info.engine,
          info.searching ? formatNps(info.nps) : null,
          `${info.lines.length} ${info.lines.length === 1 ? 'line' : 'lines'}`,
          info.depth ? `d${info.depth}` : null,
        ]
          .filter(Boolean)
          .join(' · ')
      : '',
  );
</script>

<section class="card" aria-label="Engine lines">
  <header>
    <h2>Engine</h2>
    <span>{meta}</span>
  </header>
  {#if info?.lines.length}
    <ol>
      {#each info.lines as line, i (i)}
        <li onmouseenter={() => (hovered = i)} onmouseleave={() => (hovered = null)}>
          <span class="score" class:best={i === 0}>{formatScore(line.score)}</span>
          <span class="pv">
            {#each formatLine(info.ply, line.san).split(' ') as t, j (j)}<span class:num={/^\d+\.+$/.test(t)}>
                {t + ' '}
              </span>{/each}
          </span>
        </li>
      {/each}
    </ol>
    {#if preview}<div class="preview"><Board position={preview} /></div>{/if}
  {:else}
    <p>{info ? 'Waiting for lines…' : 'No engine output'}</p>
  {/if}
</section>

<style>
  .card {
    position: relative;
    border-radius: var(--radius);
    background: var(--surface);
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 10px 16px 6px;
  }
  h2 {
    margin: 0;
    font-size: 12px;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--muted);
  }
  header span {
    overflow: hidden;
    font-size: 12px;
    color: var(--muted);
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  ol {
    margin: 0;
    padding: 0;
    list-style: none;
  }
  li {
    display: flex;
    align-items: center;
    gap: 12px;
    min-height: 34px;
    padding: 0 16px;
    border-top: 1px solid var(--surface3);
  }
  li:last-child {
    border-radius: 0 0 var(--radius) var(--radius);
  }
  li:hover {
    background: var(--surface3);
  }
  .score {
    flex: none;
    width: 58px;
    padding: 2px 0;
    border-radius: 4px;
    background: var(--line);
    font: 600 13px var(--fontMono);
    text-align: center;
  }
  .score.best {
    background: var(--evalW);
    color: var(--onLight);
  }
  .pv {
    flex: 1 1 0;
    min-width: 0;
    overflow: hidden;
    font: 400 13.5px var(--fontMono);
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .num {
    color: var(--dim);
  }
  p {
    margin: 0;
    padding: 8px 16px 14px;
    color: var(--muted);
  }
  /* End position of the hovered line, over the cards below. */
  .preview {
    position: absolute;
    top: 100%;
    right: 12px;
    z-index: 2;
    width: 320px;
    overflow: hidden;
    border: 4px solid var(--surface);
    border-radius: var(--radius);
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
  }
</style>
