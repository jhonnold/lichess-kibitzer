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
  const { polledAt } = $derived(status.follow);
  const t = $derived(status.timing);
</script>

<h3>Engine</h3>
<p>
  <b>{engine}</b> · {status.restarts} restarts since start · <small>{status.engine.path}</small>
</p>

<h3>Queue</h3>
<p>
  {#if status.running}
    Running: <b>Board {boardNo(status.running.boardId)} · ply {status.running.ply} ({status.running.tier})</b>
    · depth {search?.depth ?? '–'} · {search ? `${sec(now - search.startedAt)} s` : '–'}
  {:else}Idle{/if}
</p>
{#if queued.length}
  <ol>
    {#each queued as j (j.boardId + ':' + j.ply)}
      <li>Board {boardNo(j.boardId)} · ply {j.ply}</li>
    {/each}
  </ol>
{:else}
  <p>Current tier: empty</p>
{/if}
<p>Backfill: <b>{snap?.queue.backfill ?? status.queue.backfill}</b> positions</p>

<h3>Dead-letter queue</h3>
{#if status.dead.length}
  <ul>
    {#each status.dead as d (d.boardId + ':' + d.ply)}
      <li>
        Board {d.board} · ply {d.ply} ({moveLabel(d)}) · since {new Date(d.at).toLocaleTimeString()}
        <button disabled={busy} onclick={() => onDead('requeue', d)}>Requeue</button>
        <button disabled={busy} onclick={() => onDead('discard', d)}>Discard</button>
      </li>
    {/each}
  </ul>
{:else}
  <p>none</p>
{/if}

<h3>Timing</h3>
{#if t.jobs === 0 || !t.ms || !t.depth}
  <p>no Jobs yet · job time {formatJobTime(status.jobTimeMs)}</p>
{:else}
  <p>
    Job time: p50 <b>{sec(t.ms.p50)} s</b> · p95 <b>{sec(t.ms.p95)} s</b> (set {formatJobTime(status.jobTimeMs)})
  </p>
  <p>
    Depth: p50 <b>{t.depth.p50}</b> · p95 <b>{t.depth.p95}</b> · over {t.jobs} Jobs ({t.provisional} Provisional)
  </p>
{/if}

<h3>Lichess</h3>
<p class="last">
  Last Event poll:
  <b>
    {polledAt === null
      ? '–'
      : `${new Date(polledAt).toLocaleTimeString()} · ${Math.max(0, Math.round((now - polledAt) / 1000))} s ago`}
  </b>
</p>

<style>
  h3 {
    margin: 12px 0 4px;
    font-size: 1em;
  }
  p,
  ol,
  ul {
    margin: 4px 0;
  }
  .last {
    margin-bottom: 10px;
  }
  ul {
    padding-left: 0;
    list-style: none;
  }
  li button {
    margin-left: 6px;
  }
</style>
