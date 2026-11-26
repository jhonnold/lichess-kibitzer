<script lang="ts">
  import { onMount } from 'svelte';
  import Viewer from './pages/Viewer.svelte';
  import Admin from './pages/Admin.svelte';
  import Overview from './pages/Overview.svelte';
  import { LiveStore } from '$lib/live.svelte';
  import { boardHash, parseHash, ROUND_HASH } from '$shared/route';

  // Hash router: see shared/route.ts. One LiveStore (one EventSource) for every page.
  let hash = $state(location.hash);
  const route = $derived(parseHash(hash).route);
  const store = new LiveStore();

  let lastBoard = $state<number | null>(null);
  $effect(() => {
    if (route.page === 'viewer') lastBoard = route.board;
  });
  // Where `o` returns to from the overview: the last Board seen, else the Viewer's default (board 1 may be untracked).
  const back = $derived(lastBoard === null ? '#/' : boardHash(lastBoard));

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
      e.altKey ||
      e.ctrlKey ||
      e.metaKey ||
      t?.isContentEditable ||
      /^(INPUT|TEXTAREA|SELECT)$/.test(t?.tagName ?? '')
    )
      return;
    location.hash = route.page === 'round' ? back : ROUND_HASH;
  }
</script>

<svelte:window onkeydown={onKey} />

{#if route.page === 'admin'}
  <Admin {store} />
{:else if route.page === 'round'}
  <Overview {store} {back} />
{:else}
  <Viewer {store} board={route.board} />
{/if}
