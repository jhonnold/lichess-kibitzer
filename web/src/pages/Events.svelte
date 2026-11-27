<script lang="ts">
  import { onMount } from 'svelte';
  import type { LiveStore } from '$lib/live.svelte';
  import { eventCards } from '$shared/events';
  import { countdown } from '$shared/viewer';

  // Every registered Event; a card opens that Event's overview. Needs only the site-wide list, not the stream's Event.
  const { store, query }: { store: LiveStore; query: string } = $props();
  const snap = $derived(store.snap);
  const cards = $derived(eventCards(store.events));
  // 'starting' is the countdown's own text for a start time that has passed
  const startsIn = (startsAt: number | null) => {
    const left = countdown(startsAt, now - store.skew);
    return left === null ? 'Upcoming' : left === 'starting' ? left : `starts in ${left}`;
  };
  let now = $state(Date.now());
  onMount(() => {
    const tick = setInterval(() => (now = Date.now()), 1000);
    return () => clearInterval(tick);
  });
</script>

{#if !snap}
  <main class="message">{store.connected ? 'Loading…' : 'Connecting…'}</main>
{:else if cards.length === 0}
  <main class="message">Nothing live right now</main>
{:else}
  <main>
    <header>
      <h1>Events</h1>
      <p class="summary">{cards.length} followed</p>
    </header>
    <div class="grid">
      {#each cards as c (c.tourId)}
        <a class="card" href={c.href + query}>
          <p class="name">
            {c.name}{#if c.primary}<span class="primary" title="The Event that #/board/n links follow">
                Primary
              </span>{/if}
          </p>
          <p class="round">{c.round ?? 'Waiting for the first Round'}</p>
          <p class="meta">
            {#if c.state === 'live'}
              <span class="live"><span></span>LIVE</span>
            {:else if c.state === 'upcoming'}
              <span>{startsIn(c.startsAt)}</span>
            {/if}
            {#if c.state !== 'idle'}<span>{c.tracked} tracked {c.tracked === 1 ? 'board' : 'boards'}</span>{/if}
          </p>
        </a>
      {/each}
    </div>
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
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
    gap: 16px;
    max-width: 1440px;
    margin: 0 auto;
  }
  .card {
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
    padding: 14px 16px;
    border: 1px solid var(--line);
    border-radius: var(--radius);
    background: var(--surface2);
    color: inherit;
    text-decoration: none;
  }
  .card:hover,
  .card:focus-visible {
    border-color: var(--accent);
  }
  p {
    margin: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .name {
    font-size: 17px;
    font-weight: 700;
    letter-spacing: -0.01em;
  }
  .primary {
    margin-left: 8px;
    padding: 1px 6px;
    border-radius: 4px;
    background: var(--surface3);
    color: var(--text2);
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    vertical-align: 2px;
  }
  .round {
    color: var(--text2);
  }
  .meta {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px 12px;
    margin-top: 6px;
    color: var(--muted);
    font-size: 13px;
  }
  .live {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 2px 7px;
    border-radius: 999px;
    background: var(--liveBg);
    color: var(--liveText);
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.06em;
  }
  .live span {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--live);
  }
  @media (max-width: 699px) {
    main {
      padding: 12px 12px 24px;
    }
    h1 {
      font-size: 22px;
    }
    .grid {
      grid-template-columns: minmax(0, 1fr);
      gap: 8px;
    }
  }
</style>
