<script lang="ts">
  import { onMount } from 'svelte';
  import { fetchArchive } from '$lib/archive.svelte';
  import type { ArchiveEvent } from '$shared/archive';
  import { archiveHash } from '$shared/route';

  let events = $state<ArchiveEvent[] | null>(null);
  let error = $state<string | null>(null);
  onMount(() => {
    fetchArchive().then(
      (e) => (events = e),
      (e: Error) => (error = e.message),
    );
  });
</script>

<main>
  <header>
    <h1>Archive</h1>
    <a href="#/">Back to live</a>
  </header>
  {#if error}
    <p class="note">{error}</p>
  {:else if !events}
    <p class="note">Loading…</p>
  {:else if !events.length}
    <p class="note">No archived Rounds yet</p>
  {:else}
    {#each events as ev (ev.tourId)}
      <h2>{ev.name}</h2>
      <ul>
        {#each ev.rounds as r (r.roundId)}
          <li>
            <a href={archiveHash(r.tourId, r.roundId)}>{r.name}</a>
            <span class="muted">
              {#if r.startsAt !== null}{new Date(r.startsAt).toLocaleDateString()} ·
              {/if}{r.boards}
              {r.boards === 1 ? 'board' : 'boards'}
            </span>
          </li>
        {/each}
      </ul>
    {/each}
  {/if}
</main>

<style>
  main {
    height: 100%;
    padding: 12px 24px;
    overflow-y: auto;
  }
  header {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
  }
  h1 {
    margin: 0;
    font-size: 24px;
  }
  h2 {
    margin: 24px 0 8px;
    font-size: 20px;
  }
  header a,
  li a {
    color: var(--accent);
  }
  ul {
    margin: 0;
    padding: 0;
    list-style: none;
  }
  li {
    display: flex;
    gap: 16px;
    padding: 8px 12px;
    font-size: 18px;
    background: var(--surface2);
    border-bottom: 1px solid var(--line);
  }
  .muted,
  .note {
    color: var(--muted);
  }
  .note {
    font-size: 24px;
  }
</style>
