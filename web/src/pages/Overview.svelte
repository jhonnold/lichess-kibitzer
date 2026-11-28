<script lang="ts">
  import { onMount } from 'svelte';
  import type { SnapSource } from '$lib/live.svelte';
  import { outcomeOf, type ArchiveCtx } from '$shared/archive';
  import type { Layout } from '$shared/route';
  import { archiveHash, boardHash } from '$shared/route';
  import { boardState, viewerMessage } from '$shared/viewer';
  import BoardTile from '../components/BoardTile.svelte';

  // ctx: an archived Round (no Queue dots, links stay in the Archive).
  const {
    store,
    layout,
    query = '',
    ctx = null,
    tourId = null,
  }: { store: SnapSource; layout: Layout; query?: string; ctx?: ArchiveCtx | null; tourId?: string | null } = $props();
  const href = $derived(
    (n: number) => (ctx ? archiveHash(ctx.tourId, ctx.roundId, n) : boardHash(n, undefined, tourId)) + query,
  );
  const snap = $derived(store.snap);
  let now = $state(Date.now());
  onMount(() => {
    const tick = setInterval(() => (now = Date.now()), 1000);
    return () => clearInterval(tick);
  });

  // Tracked boards first, then the others (shown, not analysed automatically); each part in board order.
  const tracked = $derived(snap?.round?.boards.filter((b) => b.tracked) ?? []);
  const others = $derived(snap?.round?.boards.filter((b) => !b.tracked) ?? []);
  const sections = $derived(
    tracked.length && others.length
      ? [
          { title: 'Tracked', boards: tracked },
          { title: 'Other boards', boards: others },
        ]
      : [{ title: null, boards: tracked.length ? tracked : others }],
  );

  /** "6 live · 1 finished": how many Boards (every one) are in each state, zero counts left out. */
  const summary = $derived.by(() => {
    const boards = snap?.round?.boards ?? [];
    const count = (names: string[], of: (b: (typeof boards)[number]) => string) =>
      names
        .map((n) => [n, boards.filter((b) => of(b) === n).length] as const)
        .filter(([, k]) => k > 0)
        .map(([n, k]) => ({ text: `${k} ${n === 'notPlayed' ? 'not played' : n}`, live: n === 'live' }));
    return ctx
      ? count(['finished', 'unfinished', 'notPlayed'], outcomeOf)
      : count(['live', 'finished', 'upcoming'], boardState);
  });
</script>

{#if !snap}
  <main class="message">{store.connected ? 'Loading…' : 'Connecting…'}</main>
{:else if !snap.round || !snap.round.boards.length}
  <main class="message">{viewerMessage(snap) ?? 'Nothing live right now'}</main>
{:else}
  <main>
    {#if layout.chrome}
      <header>
        <div>
          {#if snap.event}<p class="event">{snap.event.name}</p>{/if}
          <h1>{snap.round.name}</h1>
        </div>
        <p class="summary">
          <span>{snap.round.boards.length} {snap.round.boards.length === 1 ? 'board' : 'boards'}</span>
          {#if !ctx || tracked.length}<span>{tracked.length} tracked</span>{/if}
          {#each summary as part (part.text)}<span class:live={part.live}>{part.text}</span>{/each}
          {#if ctx && tracked.length}<span>analysis as of the swap</span>{/if}
        </p>
        {#if !ctx}
          <p class="legend">
            <span><i class="searching"></i>Analysing</span>
            <span><i class="queued"></i>Queued</span>
            <span><i></i>Up to date</span>
            {#if others.length}<span><i class="off"></i>Not analysed</span>{/if}
          </p>
        {/if}
      </header>
    {/if}
    {#each sections as sec (sec.title)}
      {#if sec.title}<h2>{sec.title} <span>{sec.boards.length}</span></h2>{/if}
      <div class="grid">
        {#each sec.boards as b (b.id)}
          <BoardTile board={b} search={snap.search} queue={snap.queue} {href} archived={!!ctx} now={now - store.skew} />
        {/each}
      </div>
    {/each}
  </main>
{/if}

<style>
  main {
    height: 100%;
    padding: 20px 16px 32px;
    overflow-y: auto;
  }
  .message {
    display: grid;
    place-items: center;
    font-size: 24px;
    color: var(--muted);
    text-align: center;
  }
  header {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-end;
    gap: 12px 24px;
    max-width: 1440px;
    margin: 0 auto 16px;
  }
  .event {
    margin: 0 0 2px;
    color: var(--muted);
    font-size: 13px;
  }
  h1 {
    margin: 0;
    font-size: 26px;
    font-weight: 700;
    letter-spacing: -0.02em;
  }
  .summary {
    margin: 0 0 3px;
    color: var(--text2);
  }
  .summary .live {
    color: var(--liveText);
  }
  .summary span + span::before {
    content: ' · ';
    color: var(--muted);
  }
  .legend {
    display: flex;
    flex-wrap: wrap;
    gap: 14px;
    margin: 0 0 3px auto;
    color: var(--muted);
    font-size: 12px;
  }
  .legend span {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  i {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--muted);
  }
  i.searching {
    background: var(--accent);
  }
  i.queued {
    background: var(--warn);
  }
  i.off {
    background: transparent;
    box-shadow: inset 0 0 0 1px var(--muted);
  }
  h2 {
    max-width: 1440px;
    margin: 0 auto 10px;
    color: var(--muted);
    font-size: 12px;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }
  h2 span {
    margin-left: 6px;
    font-family: var(--fontMono);
    letter-spacing: 0;
  }
  .grid + h2 {
    margin-top: 28px;
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
    gap: 16px;
    max-width: 1440px;
    margin: 0 auto;
  }
  @media (max-width: 699px) {
    main {
      padding: 12px 12px 24px;
    }
    h1 {
      font-size: 22px;
    }
    .legend {
      margin-left: 0;
    }
    .grid {
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 8px;
    }
  }
</style>
