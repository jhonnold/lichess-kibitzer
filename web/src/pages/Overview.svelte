<script lang="ts">
  import type { SnapSource } from '$lib/live.svelte';
  import type { ArchiveCtx } from '$shared/archive';
  import { archiveHash } from '$shared/route';
  import { viewerMessage } from '$shared/viewer';
  import BoardTile from '../components/BoardTile.svelte';

  // back: the Viewer hash `o` returns to. ctx: an archived Round (no Queue dots, links stay in the Archive).
  const { store, back, ctx = null }: { store: SnapSource; back: string; ctx?: ArchiveCtx | null } = $props();
  const href = $derived(ctx ? (n: number) => archiveHash(ctx.tourId, ctx.roundId, n) : undefined);
  const snap = $derived(store.snap);
</script>

{#if !snap}
  <main class="message">{store.connected ? 'Loading…' : 'Connecting…'}</main>
{:else if !snap.round || !snap.round.boards.length}
  <main class="message">{viewerMessage(snap) ?? 'Nothing live right now'}</main>
{:else}
  <main>
    <header>
      <h1>{ctx ? 'Archive · ' : ''}{snap.event?.name} · {snap.round.name}</h1>
      <a href={back}>Board view (o)</a>
    </header>
    <div class="grid">
      {#each snap.round.boards as b (b.id)}
        <BoardTile board={b} search={snap.search} queue={snap.queue} {href} archived={!!ctx} />
      {/each}
    </div>
  </main>
{/if}

<style>
  main {
    --b: max(160px, min(calc((100vh - 236px) / 2), calc((100vw - 80px) / 4 - 34px)));
    height: 100vh;
    padding: 12px 16px;
    overflow-y: auto;
  }
  .message {
    display: grid;
    place-items: center;
    font-size: 32px;
    color: var(--muted);
  }
  header {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    margin-bottom: 8px;
  }
  h1 {
    margin: 0;
    font-size: 20px;
  }
  header a {
    color: var(--accent);
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, calc(var(--b) + 34px));
    gap: 16px;
    justify-content: center;
  }
</style>
