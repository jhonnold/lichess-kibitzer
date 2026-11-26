<script lang="ts">
  import { play, type PanelInfo } from '$shared/viewer';
  import { formatLine, formatNps, formatScore } from '$lib/format';
  import Board from './Board.svelte';

  // fen: the position at info.ply, which the lines are played from.
  type Props = { info: PanelInfo | null; fen: string };
  const { info, fen }: Props = $props();

  let hovered = $state<number | 'main' | null>(null); // a Lines row, or the main line
  const pv = $derived(hovered === null ? undefined : (hovered === 'main' ? info?.main : info?.lines[hovered])?.san);
  const preview = $derived.by(() => {
    try {
      return pv && play(fen, pv);
    } catch {
      return undefined; // a line that doesn't fit the board (stale after a move upsert): no preview
    }
  });
  const join = (parts: (string | null)[]) => parts.filter(Boolean).join(' · ');
  const meta = $derived(info ? join([info.engine, info.searching ? formatNps(info.nps) : null]) : '');
  const linesMeta = $derived(
    info?.lines.length
      ? join([
          `${info.lines.length} ${info.lines.length === 1 ? 'line' : 'lines'}`,
          info.searching ? formatNps(info.linesNps) : null,
          info.linesDepth ? `d${info.linesDepth}` : null,
        ])
      : '',
  );
</script>

{#snippet moves(san: string[])}
  {#each formatLine(info!.ply, san).split(' ') as t, j (j)}<span class:num={/^\d+\.+$/.test(t)}>{t + ' '}</span>{/each}
{/snippet}

<section class="card" aria-label="Engine lines">
  <header>
    <h2>Engine</h2>
    <span>{meta}</span>
  </header>
  {#if info?.main}
    <div
      class="main"
      role="group"
      aria-label="Main line"
      onmouseenter={() => (hovered = 'main')}
      onmouseleave={() => (hovered = null)}
    >
      <span class="score best">{formatScore(info.main.score)}</span>
      <span class="pv full">{@render moves(info.main.san)}</span>
      {#if info.depth}<span class="depth">d{info.depth}</span>{/if}
    </div>
  {/if}
  {#if info?.lines.length}
    <h3><span>Lines</span><span>{linesMeta}</span></h3>
    <ol aria-label="Lines">
      {#each info.lines as line, i (i)}
        <li onmouseenter={() => (hovered = i)} onmouseleave={() => (hovered = null)}>
          <span class="score">{formatScore(line.score)}</span>
          <span class="pv">{@render moves(line.san)}</span>
        </li>
      {/each}
    </ol>
  {/if}
  {#if !info?.main && !info?.lines.length}
    <p>{info ? 'Waiting for lines…' : 'No engine output'}</p>
  {/if}
  {#if preview}<div class="preview"><Board position={preview} /></div>{/if}
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
  /* The main copy's line: wraps to three rows at most, so the Lines and the cards below keep their place. */
  .main {
    display: flex;
    align-items: flex-start;
    gap: 12px;
    padding: 8px 16px 10px;
    border-top: 1px solid var(--surface3);
  }
  .main:hover {
    background: var(--surface3);
  }
  .main:last-child {
    border-radius: 0 0 var(--radius) var(--radius);
  }
  .main .score {
    margin-top: 1px;
  }
  .pv.full {
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 3;
    line-clamp: 3;
    white-space: normal;
    line-height: 1.45;
  }
  .depth {
    flex: none;
    margin-top: 2px;
    font: 600 12px var(--fontMono);
    color: var(--muted);
  }
  h3 {
    display: flex;
    justify-content: space-between;
    gap: 12px;
    margin: 0;
    padding: 6px 16px 4px;
    border-top: 1px solid var(--surface3);
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--muted);
  }
  h3 span:last-child {
    overflow: hidden;
    font-weight: 400;
    letter-spacing: 0;
    text-transform: none;
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
