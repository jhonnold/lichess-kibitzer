<script lang="ts">
  import { onMount } from 'svelte';
  import Viewer from './pages/Viewer.svelte';
  import Admin from './pages/Admin.svelte';
  import Overview from './pages/Overview.svelte';
  import Archive from './pages/Archive.svelte';
  import { ArchiveStore } from '$lib/archive.svelte';
  import { LiveStore } from '$lib/live.svelte';
  import { ARCHIVE_HASH, archiveHash, boardHash, layoutOf, parseHash, ROUND_HASH } from '$shared/route';

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

{#if route.page === 'admin'}
  <Admin {store} />
{:else if route.page === 'round'}
  <Overview {store} {back} {layout} {query} />
{:else if route.page === 'archive'}
  <Archive />
{:else if route.page === 'archive-round'}
  {@const ctx = { tourId: route.tourId, roundId: route.roundId }}
  {#if archive.error}
    <main class="message"><p>{archive.error} · <a href={ARCHIVE_HASH}>Archive</a></p></main>
  {:else if route.board === null}
    <Overview store={archive} back={archiveBack} {ctx} {layout} {query} />
  {:else}
    <Viewer store={archive} board={route.board} ply={route.ply} {layout} {query} {ctx} />
  {/if}
{:else}
  <Viewer {store} board={route.board} ply={route.ply} {layout} {query} />
{/if}

<style>
  .message {
    display: grid;
    place-items: center;
    height: 100vh;
    font-size: 32px;
    color: var(--muted);
  }
  .message a {
    color: var(--accent);
  }
</style>
