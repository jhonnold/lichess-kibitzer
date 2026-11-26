<script lang="ts">
  import type { DeadJob } from '$shared/queue';
  import type { Snapshot } from '$shared/types';
  import type { AdminStatus } from '$lib/admin-api';
  import { formatJobTime } from '$shared/admin-form';
  import { formatLine } from '$lib/format';

  type Props = {
    status: AdminStatus;
    snap: Snapshot | null;
    now: number;
    busy: boolean;
    onDead: (action: 'requeue' | 'discard', d: DeadJob) => void;
  };
  const { status, snap, now, busy, onDead }: Props = $props();

  const engine = $derived(
    status.engineState === 'up' ? 'up' : status.engineState === 'restarting' ? 'restarting' : '– (no Round)',
  );
  const boardNo = (id: string) => status.round?.boards.find((b) => b.id === id)?.board ?? '?';
  const queued = $derived(snap?.queue.current ?? status.queue.current);
  const search = $derived(
    status.running && snap?.search?.boardId === status.running.boardId && snap.search.ply === status.running.ply
      ? snap.search
      : null,
  );
  /** "21... Nc6": the Dead-letter queue entry's move when the Board is in the Snapshot (Tracked), else the ply. */
  const moveLabel = (d: DeadJob) => {
    const san = snap?.round?.boards.find((b) => b.id === d.boardId)?.plies[d.ply]?.move?.san;
    return san ? formatLine(d.ply - 1, [san]) : `ply ${d.ply}`;
  };
  const sec = (ms: number) => (ms / 1000).toFixed(1);
  const t = $derived(status.timing);
  const elapsed = $derived(search ? now - search.startedAt : null);
  const progress = $derived(
    elapsed === null || !status.jobTimeMs ? null : Math.min(100, (100 * elapsed) / status.jobTimeMs),
  );
</script>

<!-- Cards in the Admin status grid (the parent lays them out). -->
<article>
  <h2>Engine</h2>
  <p class="big">
    <i class={status.engineState === 'up' ? 'ok' : status.engineState === 'restarting' ? 'warn' : ''}></i>
    {engine === 'up' ? 'Up' : engine === 'restarting' ? 'Restarting' : engine}
  </p>
  <p>{status.restarts} {status.restarts === 1 ? 'restart' : 'restarts'} since start</p>
  <p class="mono" title={status.engine.path}>{status.engine.path}</p>
</article>

<article class="wide">
  <h2>Queue</h2>
  {#if status.running}
    <div class="run">
      <span class="big"><i class="busy"></i>Board {boardNo(status.running.boardId)} · ply {status.running.ply}</span>
      <span class="chip">{status.running.tier}</span>
      <span class="muted">
        depth {search?.depth ?? '–'} · {elapsed === null ? '–' : `${sec(elapsed)} s`}{#if status.jobTimeMs}
          of {status.jobTimeMs / 1000} s{/if}
      </span>
    </div>
    {#if progress !== null}
      <div
        class="bar"
        role="progressbar"
        aria-label="Running Job"
        aria-valuemin="0"
        aria-valuemax="100"
        aria-valuenow={Math.round(progress)}
      >
        <div style:width="{progress}%"></div>
      </div>
    {/if}
  {:else}
    <p class="big"><i></i>Idle</p>
  {/if}
  <div class="row">
    <span>
      Current tier <b>{queued.length ? `${queued.length} ${queued.length === 1 ? 'Job' : 'Jobs'}` : 'empty'}</b>
    </span>
    <span>Backfill <b>{snap?.queue.backfill ?? status.queue.backfill}</b> positions</span>
  </div>
  {#if queued.length}
    <ol>
      {#each queued as j (j.boardId + ':' + j.ply)}
        <li>Board {boardNo(j.boardId)} · ply {j.ply}</li>
      {/each}
    </ol>
  {/if}
</article>

<article>
  <h2>Timing</h2>
  {#if t.jobs === 0 || !t.ms || !t.depth}
    <p>No Jobs yet</p>
    <p class="muted">Job time {formatJobTime(status.jobTimeMs)}</p>
  {:else}
    <p>Job time p50 <b>{sec(t.ms.p50)} s</b> · p95 <b>{sec(t.ms.p95)} s</b></p>
    <p>Depth p50 <b>{t.depth.p50}</b> · p95 <b>{t.depth.p95}</b></p>
    <p class="muted">Set {formatJobTime(status.jobTimeMs)} · over {t.jobs} Jobs ({t.provisional} Provisional)</p>
  {/if}
</article>

<article class:alert={status.dead.length > 0}>
  <h2>Dead-letter queue</h2>
  {#if status.dead.length}
    <ul>
      {#each status.dead as d (d.boardId + ':' + d.ply)}
        <li>
          <span>
            <b>Board {d.board}</b> · ply {d.ply} ({moveLabel(d)})<br /><small>
              since {new Date(d.at).toLocaleTimeString()}
            </small>
          </span>
          <span class="actions">
            <button disabled={busy} onclick={() => onDead('requeue', d)}>Requeue</button>
            <button disabled={busy} onclick={() => onDead('discard', d)}>Discard</button>
          </span>
        </li>
      {/each}
    </ul>
  {:else}
    <p class="muted">Empty. Failed Jobs land here with Requeue and Discard.</p>
  {/if}
</article>

<style>
  p {
    margin: 0;
  }
  .big {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 16px;
    font-weight: 600;
  }
  i {
    flex: none;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--muted);
  }
  i.ok {
    background: var(--ok);
  }
  i.warn {
    background: var(--warn);
  }
  i.busy {
    background: var(--accent);
  }
  .mono {
    overflow: hidden;
    color: var(--muted);
    font: 400 13px var(--fontMono);
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .muted {
    color: var(--muted);
  }
  .run {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 4px 12px;
  }
  .run .big {
    display: inline-flex;
  }
  .chip {
    padding: 1px 8px;
    border-radius: 999px;
    background: var(--surface3);
    color: var(--text2);
    font-size: 12px;
    font-weight: 600;
  }
  .bar {
    height: 6px;
    overflow: hidden;
    border-radius: 3px;
    background: var(--surface3);
  }
  .bar div {
    height: 100%;
    background: var(--accent);
  }
  .row {
    display: flex;
    flex-wrap: wrap;
    gap: 8px 32px;
    margin-top: 4px;
  }
  ol {
    margin: 0;
    padding-left: 20px;
    color: var(--text2);
  }
  ul {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  li {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }
  small {
    color: var(--muted);
  }
  .actions {
    display: flex;
    gap: 6px;
  }
  .alert {
    border-color: var(--blunder);
  }
</style>
