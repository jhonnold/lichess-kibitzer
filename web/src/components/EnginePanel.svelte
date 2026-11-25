<script lang="ts">
  import type { LiveInfo } from '$shared/types';
  import { formatLine, formatNps, formatScore } from '$lib/format';

  type Props = { live: LiveInfo | null };
  const { live }: Props = $props();
</script>

<section>
  {#if live}
    <header>
      <span class="engine">{live.engine}</span>
      <span>depth {live.depth}</span>
      <span>{formatNps(live.nps)}</span>
    </header>
    {#each live.lines as line, i (i)}
      <div class="line">
        <span class="score">{formatScore(line.score)}</span>
        <span class="depth">d{line.depth}</span>
        <span class="pv">{formatLine(live.ply, line.san)}</span>
      </div>
    {/each}
  {:else}
    <header><span class="muted">No engine output</span></header>
  {/if}
</section>

<style>
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
  .muted {
    color: var(--muted);
  }
</style>
