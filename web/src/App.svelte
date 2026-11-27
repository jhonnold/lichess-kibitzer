<script lang="ts">
  import { onMount } from 'svelte';
  import Viewer from './pages/Viewer.svelte';
  import Admin from './pages/Admin.svelte';
  import Overview from './pages/Overview.svelte';
  import Events from './pages/Events.svelte';
  import Archive from './pages/Archive.svelte';
  import AppBar from './components/AppBar.svelte';
  import TabBar from './components/TabBar.svelte';
  import { ArchiveStore } from '$lib/archive.svelte';
  import { LiveStore } from '$lib/live.svelte';
  import { unknownTour } from '$shared/events';
  import {
    ARCHIVE_HASH,
    archiveHash,
    backHash,
    homeHash,
    layoutOf,
    navLinks,
    overviewToggle,
    parseHash,
    resolveRoute,
    routeTour,
    switchHref,
    type LastBoard,
  } from '$shared/route';
  import { boardState } from '$shared/viewer';

  // Hash router: see shared/route.ts. One LiveStore (one EventSource) for every page, bound to the stream tour.
  let hash = $state(location.hash);
  const parsed = $derived(parseHash(hash));
  const store = new LiveStore();
  // Bare `#/` is the Events list once more than one Event is registered (see resolveRoute).
  // The list-or-Viewer choice for bare `#/` is made once per navigation, at the first snapshot: an Event added or
  // removed later must not swap the screen under a Viewer.
  let nav = $state(0);
  let latched: { nav: number; list: boolean } | null = null;
  const route = $derived.by(() => {
    const n = store.events.length;
    if (latched && latched.nav !== nav) latched = null;
    if (!latched && n > 0) latched = { nav, list: n > 1 };
    return resolveRoute(parsed, n, latched?.list ?? null);
  });
  const multi = $derived(store.events.length > 1);
  // Streaming params (`?chrome=0&…`): kept verbatim by every link and URL update.
  const layout = $derived(layoutOf(parsed.params));
  const query = $derived(hash.includes('?') ? hash.slice(hash.indexOf('?')) : '');
  $effect(() => {
    document.documentElement.classList.toggle('transparent', layout.transparent);
  });
  const archive = new ArchiveStore();

  // The stream's Event: the tourId of the last Event-scoped route (sticky across Admin/Archive). Computed with the
  // route, not in an effect, so the Viewer never rewrites the new Event's hash with the old Event's. null = the Primary.
  let lastTour: string | null = null;
  const tour = $derived.by(() => {
    const t = routeTour(route);
    if (t !== undefined) lastTour = t;
    return lastTour;
  });
  // Reads only `tour` (a primitive): reconnects only when the Event changes.
  $effect(() => store.connect(tour));
  const ready = $derived(store.tour === tour);
  const notFollowed = $derived(
    (route.page === 'viewer' || route.page === 'round') && ready && unknownTour(store.snap, tour),
  );

  let last = $state<LastBoard | null>(null);
  $effect(() => {
    if (route.page === 'viewer') last = { tour: route.tourId, board: route.board };
  });
  // Where `o` returns to from the overview: the last Board seen in this Event, else its default Board (board 1 may be
  // untracked).
  const back = $derived(
    backHash(last, tour, multi && ready ? (store.snap?.round?.boards[0]?.board ?? 1) : null) + query,
  );

  // The archived Round on screen: one fetch per Round; its Boards are the Tracked ones as of the swap.
  let lastArchiveBoard = $state<number | null>(null);
  $effect(() => {
    if (route.page !== 'archive-round') return;
    archive.load(route.tourId, route.roundId);
    if (route.board !== null) lastArchiveBoard = route.board;
  });
  const archiveBack = $derived(
    route.page === 'archive-round'
      ? archiveHash(route.tourId, route.roundId, lastArchiveBoard ?? archive.snap?.round?.boards[0]?.board ?? 1) + query
      : ARCHIVE_HASH,
  );

  // Navigation (hidden under ?chrome=0): the sections, and what is on screen.
  const links = $derived(navLinks(route, back, query, tour, multi));
  const here = $derived(
    route.page === 'events'
      ? { kind: 'live' as const, event: null, round: null, live: false }
      : route.page === 'archive-round'
        ? {
            kind: 'archived' as const,
            event: archive.snap?.event?.name ?? null,
            round: archive.snap?.round?.name ?? null,
            roundHref: archiveHash(route.tourId, route.roundId) + query,
            board: route.board,
          }
        : {
            kind: 'live' as const,
            event: store.snap?.event?.name ?? null,
            round: store.snap?.round?.name ?? null,
            live: !!store.snap?.round?.boards.some((b) => boardState(b) === 'live'),
          },
  );

  onMount(() => {
    const onHashChange = () => {
      hash = location.hash;
      nav++; // also when the hash text is unchanged: the Viewer's replaceState does not update `hash`
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  });

  /** `o`: Viewer ↔ overview. Same guards as the Viewer's keys. */
  function onKey(e: KeyboardEvent) {
    const t = e.target as HTMLElement | null;
    if (
      (e.key !== 'o' && e.key !== 'O') ||
      e.altKey ||
      e.ctrlKey ||
      e.metaKey ||
      t?.isContentEditable ||
      /^(INPUT|TEXTAREA|SELECT)$/.test(t?.tagName ?? '')
    )
      return;
    const to =
      route.page === 'archive-round'
        ? route.board === null
          ? archiveBack
          : archiveHash(route.tourId, route.roundId) + query
        : overviewToggle(route, back, query);
    if (to !== null) location.hash = to;
  }
</script>

<svelte:window onkeydown={onKey} />

<div class="app">
  {#if layout.chrome}
    <AppBar
      {links}
      {here}
      stream={store.snap?.stream ?? null}
      connected={store.connected}
      events={store.events}
      current={store.snap?.event?.tourId ?? null}
      switchTo={(t) => switchHref(route, t, query)}
      showSwitch={multi && route.page !== 'events'}
    />
  {/if}
  <div class="page">
    {#if route.page === 'admin'}
      <Admin {store} />
    {:else if route.page === 'events'}
      <Events {store} {query} />
    {:else if route.page === 'round' || route.page === 'viewer'}
      {#key tour}
        {#if !ready}
          <main class="message">Connecting…</main>
        {:else if notFollowed}
          <main class="message">
            <p>
              This Event is not followed · <a href={homeHash(null) + query}>Live</a> ·
              <a href={ARCHIVE_HASH}>Archive</a>
            </p>
          </main>
        {:else if route.page === 'round'}
          <Overview {store} {layout} {query} tourId={route.tourId} />
        {:else}
          <Viewer {store} board={route.board} ply={route.ply} {layout} {query} tourId={route.tourId} />
        {/if}
      {/key}
    {:else if route.page === 'archive'}
      <Archive />
    {:else if route.page === 'archive-round'}
      {@const ctx = { tourId: route.tourId, roundId: route.roundId }}
      {#if archive.error}
        <main class="message"><p>{archive.error} · <a href={ARCHIVE_HASH}>Archive</a></p></main>
      {:else if route.board === null}
        <Overview store={archive} {ctx} {layout} {query} />
      {:else}
        <Viewer store={archive} board={route.board} ply={route.ply} {layout} {query} {ctx} />
      {/if}
    {/if}
  </div>
  {#if layout.chrome}<TabBar {links} />{/if}
</div>

<style>
  /* One screen high: the bars stay put and each page scrolls inside .page. */
  .app {
    display: flex;
    flex-direction: column;
    height: 100vh;
    height: 100dvh;
  }
  .page {
    position: relative;
    flex: 1 1 0;
    min-height: 0;
  }
  .message {
    display: grid;
    place-items: center;
    height: 100%;
    font-size: 32px;
    color: var(--muted);
  }
  .message a {
    color: var(--accent);
  }
</style>
