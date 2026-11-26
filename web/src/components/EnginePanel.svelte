<script lang="ts">
  import { play, type PanelInfo, type StatusLine } from '$shared/viewer';
  import { formatLine, formatNps, formatScore } from '$lib/format';
  import Board from './Board.svelte';

  // fen: the position at info.ply, which the lines are played from.
  type Props = { info: PanelInfo | null; fen: string; status: StatusLine | null };
  const { info, fen, status }: Props = $props();

  let hovered = $state<number | null>(null);
  const pv = $derived(hovered === null ? undefined : info?.lines[hovered]?.san);
  const preview = $derived.by(() => {
    try {
      return pv && play(fen, pv);
    } catch {
      return undefined; // a line that doesn't fit the board (stale after a move upsert): no preview
    }
  });
</script>

<section>
  {#if status}<div class="status {status.state}">{status.text}</div>{/if}
  {#if info}
    <!-- The status line above has the state and depth; this adds only what it lacks. -->
    {#if info.searching}
      <header>
        <span class="engine">{info.engine}</span>
        <span>{formatNps(info.nps)}</span>
      </header>
    {/if}
    <ol>
      {#each info.lines as line, i (i)}
        <li class="line" onmouseenter={() => (hovered = i)} onmouseleave={() => (hovered = null)}>
          <span class="score">{formatScore(line.score)}</span>
          <span class="depth">d{line.depth}</span>
          <span class="pv">{formatLine(info.ply, line.san)}</span>
        </li>
      {/each}
    </ol>
    {#if preview}<div class="preview"><Board position={preview} /></div>{/if}
  {:else}
    <header><span class="muted">No engine output</span></header>
  {/if}
</section>

<style>
  section {
    position: relative;
  }
  .status {
    padding: 6px 12px;
    color: var(--muted);
    background: var(--surface2);
  }
  .status.searching {
    color: var(--accent);
  }
  .status.done {
    color: var(--text);
  }
  header {
    display: flex;
    gap: 16px;
    padding: 8px 12px;
    background: var(--surface);
    color: var(--muted);
  }
  .engine {
    color: var(--text);
    font-weight: 600;
  }
  ol {
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .line {
    display: flex;
    gap: 10px;
    padding: 6px 12px;
    border-bottom: 1px solid var(--line);
    font-family: var(--fontMono);
    white-space: nowrap;
  }
  .score {
    min-width: 56px;
    font-weight: 700;
  }
  .depth {
    color: var(--muted);
  }
  .pv {
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .line:hover {
    background: var(--surface);
  }
  /* End position of the hovered line, over the graph and move list below. */
  .preview {
    position: absolute;
    top: 100%;
    right: 12px;
    z-index: 1;
    width: 320px;
    border: 4px solid var(--surface);
  }
  .muted {
    color: var(--muted);
  }
</style>
