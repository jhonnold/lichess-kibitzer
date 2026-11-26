<script lang="ts">
  import { onMount } from 'svelte';
  import Viewer from './pages/Viewer.svelte';
  import Admin from './pages/Admin.svelte';
  import { parseHash } from '$shared/route';

  // Hash router: see shared/route.ts. Viewer stays mounted across hash changes (one EventSource).
  let hash = $state(location.hash);
  const route = $derived(parseHash(hash).route);

  onMount(() => {
    const onHashChange = () => (hash = location.hash);
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  });
</script>

{#if route.page === 'admin'}
  <Admin />
{:else}
  <Viewer board={route.board} />
{/if}
