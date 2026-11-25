<script lang="ts">
  import { onMount } from 'svelte';
  import Viewer from './pages/Viewer.svelte';
  import Admin from './pages/Admin.svelte';

  // Hash router: `#/admin` → Admin, anything else → Viewer.
  let hash = $state(location.hash);

  onMount(() => {
    const onHashChange = () => (hash = location.hash);
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  });
</script>

{#if hash === '#/admin'}
  <Admin />
{:else}
  <Viewer />
{/if}
