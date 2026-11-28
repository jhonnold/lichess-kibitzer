<script lang="ts">
  import type { DeadJob, EvictedJob, Eviction } from '$shared/queue';
  import type { Snapshot } from '$shared/types';
  import type { AdminStatus } from '$lib/admin-api';
  import { boardIndex, formatJobTime, formatPasses } from '$shared/admin-form';
  import { formatLine } from '$lib/format';
  import { archiveHash, boardHash } from '$shared/route';

  type Props = {
    status: AdminStatus;
    snap: Snapshot | null;
    now: number;
    busy: boolean;
    onDead: (action: 'requeue' | 'discard', d: DeadJob) => void;
    onCancelDeep: (boardId: string) => void;
  };
  const { status, snap, now, busy, onDead, onCancelDeep }: Props = $props();

  const COPIES = [
    ['main', 'Main line'],
    ['multi', 'Lines'],
  ] as const;
  const stateLabel = (s: AdminStatus['copies']['main']['state']) =>
    s === 'up' ? 'Up' : s === 'restarting' ? 'Restarting' : '– (no Round)';
  const idx = $derived(boardIndex(status.events));
  const boardNo = (id: string) => idx.get(id)?.board ?? '?';
  const several = $derived(status.events.length > 1);
  const eventName = (tourId: string) => status.events.find((e) => e.event.tourId === tourId)?.event.name ?? tourId;
  /** Every Event's entries, oldest first. */
  const dead = $derived(status.events.flatMap((e) => e.dead).sort((a, b) => a.at - b.at));
  const queued = $derived(snap?.queue.current ?? status.queue.current);
  const deferred = $derived(snap?.queue.deferred ?? status.queue.deferred);
  const REASON: Record<Eviction, string> = {
    stale: 'its Board moved on',
    live: 'another live position waited',
    backfill: 'a live position waited',
    upgrade: 'a shorter Pass waited, an Event went live, or its Pass was turned off',
  };
  const search = $derived(
    status.running && snap?.search?.boardId === status.running.boardId && snap.search.ply === status.running.ply
      ? snap.search
      : null,
  );
  /** "21... Nc6": the position's move when the Board is in the Snapshot (Tracked), else the ply. */
  const moveLabel = (d: DeadJob | EvictedJob) => {
    const san = snap?.round?.boards.find((b) => b.id === d.boardId)?.plies[d.ply]?.move?.san;
    return san ? ` (${formatLine(d.ply - 1, [san])})` : '';
  };
  const sec = (ms: number) => (ms / 1000).toFixed(1);
  const timings = $derived(status.timing.map((t, k) => ({ t, k })).filter(({ t }) => t.jobs + t.provisional > 0));
  const elapsed = $derived(search ? now - search.startedAt : null);
  const jobMs = $derived(status.running ? (status.passesMs?.[status.running.pass] ?? null) : null);
  // One string: Svelte drops the space at the start of an {#if} block ("4.0 sof 15 s").
  const runLabel = $derived(
    [
      `depth ${search?.depth ?? '–'}${search?.multi ? ` (Lines ${search.multi.depth})` : ''}`,
      `${elapsed === null ? '–' : `${sec(elapsed)} s`}${jobMs ? ` of ${jobMs / 1000} s` : ''}`,
    ].join(' · '),
  );
  const progress = $derived(elapsed === null || !jobMs ? null : Math.min(100, (100 * elapsed) / jobMs));
  const held = $derived(
    !status.deepHeld
      ? null
      : status.deepHeld.reason === 'live'
        ? `held: ${status.deepHeld.name} live`
        : status.deepHeld.reason === 'pass 3 off'
          ? 'held: Pass 3 off'
          : 'waiting for regular Jobs',
  );
  /** The Board in the Viewer: live while its Round is its Event's Current Round, else in the Archive. */
  const deepHref = (d: AdminStatus['deep'][number]) => {
    const current = status.events.some((e) => e.round?.tourId === d.tourId && e.round.roundId === d.roundId);
    return current ? boardHash(d.board, undefined, d.tourId) : archiveHash(d.tourId, d.roundId, d.board);
  };
  const roundName = (d: AdminStatus['deep'][number]) =>
    status.events.find((e) => e.round?.tourId === d.tourId && e.round.roundId === d.roundId)?.round?.name ??
    `Round ${d.roundId}`;
</script>

<!-- Cards in the Admin status grid (the parent lays them out). Depth and elapsed time come from the stream's Event
     (the one EventSource): a Job of another Event shows "depth – · – s". -->
<article>
  <h2>Engine</h2>
  {#each COPIES as [role, label] (role)}
    {@const c = status.copies[role]}
    <p class="big">
      <i class={c.state === 'up' ? 'ok' : c.state === 'restarting' ? 'warn' : ''}></i>
      {label}: {stateLabel(c.state)}
    </p>
    <p>{c.restarts} {c.restarts === 1 ? 'restart' : 'restarts'} since start</p>
  {/each}
  <p class="mono" title={status.engine.path}>{status.engine.path}</p>
</article>

<article class="wide">
  <h2>Queue</h2>
  {#if status.running}
    <div class="run">
      <span class="big"><i class="busy"></i>Board {status.running.board} · ply {status.running.ply}</span>
      <span class="chip">{status.running.deep ? 'deep' : status.running.tier}</span>
      <span class="chip">Pass {status.running.pass + 1}</span>
      <span class="muted">
        {runLabel}
      </span>
      <span class="muted">{eventName(status.running.tourId)}</span>
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
    {#each status.passCounts.slice(1) as n, k (k)}
      <span>Pass {k + 2} <b>{n}</b> waiting</span>
    {/each}
  </div>
  {#if queued.length}
    <ol>
      {#each queued as j (j.boardId + ':' + j.ply)}
        <li class="job">
          Board {boardNo(j.boardId)} · ply {j.ply}{#if several}<span class="muted">
              {' · ' + (idx.get(j.boardId)?.event ?? '')}
            </span>{/if}
        </li>
      {/each}
    </ol>
  {/if}
  {#if deferred.length}
    <p class="muted">Full search queued (latest position, evicted) for</p>
    <ol>
      {#each deferred as j (j.boardId + ':' + j.ply)}
        <li class="job">
          Board {boardNo(j.boardId)} · ply {j.ply}{#if several}<span class="muted">
              {' · ' + (idx.get(j.boardId)?.event ?? '')}
            </span>{/if}
        </li>
      {/each}
    </ol>
  {/if}
</article>

<article>
  <h2>Timing</h2>
  {#each timings as { t, k } (k)}
    <p>
      Pass {k + 1}
      {#if t.ms && t.depth}
        · time p50 <b>{sec(t.ms.p50)} s</b> · p95 <b>{sec(t.ms.p95)} s</b> · depth p50 <b>{t.depth.p50}</b> · p95
        <b>{t.depth.p95}</b>
      {/if}
    </p>
    <p class="muted">
      Set {status.passesMs?.[k] ? formatJobTime(status.passesMs[k]) : 'off'} · over {t.jobs} Jobs ({t.provisional} stopped
      early)
    </p>
  {:else}
    <p>No Jobs yet</p>
    <p class="muted">Passes {formatPasses(status.passesMs)}</p>
  {/each}
</article>

<article class:alert={dead.length > 0}>
  <h2>Dead-letter queue</h2>
  {#if dead.length}
    <ul>
      {#each dead as d (d.boardId + ':' + d.ply)}
        <li>
          <span>
            <b>Board {d.board}</b> · ply {d.ply}{moveLabel(d)}<br /><small>
              {eventName(d.tourId)} · since {new Date(d.at).toLocaleTimeString()}
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

<article>
  <h2>Deep analysis</h2>
  {#if status.deep.length}
    {#if held}<p class="muted">{held}</p>{/if}
    <ul>
      {#each status.deep as d (d.boardId)}
        {@const done = d.total - d.left}
        <li class="deep">
          <span>
            <a href={deepHref(d)}><b>Board {d.board}</b></a> · {done}/{d.total} plies<br /><small>
              {eventName(d.tourId)} · {roundName(d)}
            </small>
          </span>
          <button disabled={busy} onclick={() => onCancelDeep(d.boardId)}>Cancel</button>
          <div
            class="bar"
            role="progressbar"
            aria-label="Deep analysis of Board {d.board}"
            aria-valuemin="0"
            aria-valuemax={d.total}
            aria-valuenow={done}
          >
            <div style:width="{d.total ? (100 * done) / d.total : 0}%"></div>
          </div>
        </li>
      {/each}
    </ul>
  {:else}
    <p class="muted">None. An Admin starts one from a Board's Viewer (Deep analysis).</p>
  {/if}
</article>

<article>
  <h2>Recent evictions</h2>
  {#if status.evictions.length}
    <ul>
      {#each status.evictions as v, i (i)}
        <li>
          <span>
            <b>Board {v.board}</b> · ply {v.ply}{moveLabel(v)} · depth {v.depth ?? '–'}<br /><small>
              {eventName(v.tourId)} · {new Date(v.at).toLocaleTimeString()} · {REASON[v.reason]}
            </small>
          </span>
        </li>
      {/each}
    </ul>
  {:else}
    <p class="muted">None yet. A Job stopped early, and why, shows here.</p>
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
  li.job {
    display: list-item;
  }
  li.deep .bar {
    flex-basis: 100%;
  }
  li.deep .bar div {
    background: var(--deep);
  }
  a {
    color: inherit;
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
