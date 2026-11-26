<script lang="ts">
  import { onMount } from 'svelte';
  import Viewer from './pages/Viewer.svelte';
  import Admin from './pages/Admin.svelte';
  import Overview from './pages/Overview.svelte';
  import Archive from './pages/Archive.svelte';
  import AppBar from './components/AppBar.svelte';
  import TabBar from './components/TabBar.svelte';
  import { ArchiveStore } from '$lib/archive.svelte';
  import { LiveStore } from '$lib/live.svelte';
  import { ARCHIVE_HASH, archiveHash, boardHash, layoutOf, navLinks, parseHash, ROUND_HASH } from '$shared/route';
  import { boardState } from '$shared/viewer';

  // Hash router: see shared/route.ts. One LiveStore (one EventSource) for every page.
  let hash = $state(location.hash);
  const parsed = $derived(parseHash(hash));
  const route = $derived(parsed.route);
  // Streaming params (`?chrome=0&…`): kept verbatim by every link and URL update.
  const layout = $derived(layoutOf(parsed.params));
  const query = $derived(hash.includes('?') ? hash.slice(hash.indexOf('?')) : '');
  $effect(() => {
    document.documentElement.classList.toggle('transparent', layout.transparent);
  });
  const store = new LiveStore();
  const archive = new ArchiveStore();

  let lastBoard = $state<number | null>(null);
  $effect(() => {
    if (route.page === 'viewer') lastBoard = route.board;
  });
  // Where `o` returns to from the overview: the last Board seen, else the Viewer's default (board 1 may be untracked).
  const back = $derived((lastBoard === null ? '#/' : boardHash(lastBoard)) + query);

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
  const links = $derived(navLinks(route, back, query));
  const here = $derived(
    route.page === 'archive-round'
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
    const onHashChange = () => (hash = location.hash);
    window.addEventListener('hashchange', onHashChange);
    const disconnect = store.connect();
    return () => (window.removeEventListener('hashchange', onHashChange), disconnect());
  });

  /** `o`: Viewer ↔ overview. Same guards as the Viewer's keys. */
  function onKey(e: KeyboardEvent) {
    const t = e.target as HTMLElement | null;
    if (
      (e.key !== 'o' && e.key !== 'O') ||
      route.page === 'admin' ||
      route.page === 'archive' ||
      e.altKey ||
      e.ctrlKey ||
      e.metaKey ||
      t?.isContentEditable ||
      /^(INPUT|TEXTAREA|SELECT)$/.test(t?.tagName ?? '')
    )
      return;
    location.hash =
      route.page === 'archive-round'
        ? route.board === null
          ? archiveBack
          : archiveHash(route.tourId, route.roundId) + query
        : route.page === 'round'
          ? back
          : ROUND_HASH + query;
  }
</script>

<svelte:window onkeydown={onKey} />

<div class="app">
  {#if layout.chrome}
    <AppBar {links} {here} stream={store.snap?.stream ?? null} connected={store.connected} />
  {/if}
  <div class="page">
    {#if route.page === 'admin'}
      <Admin {store} />
    {:else if route.page === 'round'}
      <Overview {store} {layout} {query} />
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
    {:else}
      <Viewer {store} board={route.board} ply={route.ply} {layout} {query} />
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
