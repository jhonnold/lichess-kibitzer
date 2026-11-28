<script lang="ts">
  import { onMount } from 'svelte';
  import { fetchArchive } from '$lib/archive.svelte';
  import type { ArchiveEvent, ArchiveRound } from '$shared/archive';
  import { archiveHash } from '$shared/route';

  let events = $state<ArchiveEvent[] | null>(null);
  let error = $state<string | null>(null);
  onMount(() => {
    fetchArchive().then(
      (e) => (events = e),
      (e: Error) => (error = e.message),
    );
  });
  /** Outcome chips, zero counts left out. */
  const chips = (r: ArchiveRound) =>
    (
      [
        ['finished', r.outcomes.finished],
        ['unfinished', r.outcomes.unfinished],
        ['not played', r.outcomes.notPlayed],
      ] as const
    )
      .filter(([, n]) => n > 0)
      .map(([what, n]) => ({ what, text: `${n} ${what}` }));
</script>

<main>
  <div class="wrap">
    <h1>Archive</h1>
    <p class="lede">Finished Rounds: every Board, with the analysis it got live and any deep analysis since.</p>
    {#if error}
      <p class="note">{error}</p>
    {:else if !events}
      <p class="note">Loading…</p>
    {:else if !events.length}
      <p class="note">No archived Rounds yet</p>
    {:else}
      {#each events as ev (ev.tourId)}
        <section>
          <h2>{ev.name} <span>{ev.rounds.length} {ev.rounds.length === 1 ? 'Round' : 'Rounds'}</span></h2>
          <ul>
            {#each ev.rounds as r (r.roundId)}
              <li>
                <a href={archiveHash(r.tourId, r.roundId)}>
                  <div class="what">
                    <div class="name">{r.name}</div>
                    <div class="meta">
                      {#if r.startsAt !== null}{new Date(r.startsAt).toLocaleDateString()} ·
                      {/if}{r.boards}
                      {r.boards === 1 ? 'board' : 'boards'}
                    </div>
                  </div>
                  <div class="chips">
                    {#each chips(r) as c (c.what)}<span class="chip {c.what === 'finished' ? 'strong' : ''}">
                        {c.text}
                      </span>{/each}
                  </div>
                  <span class="open">
                    Open
                    <svg
                      width="14"
                      height="14"
                      viewBox="0 0 24 24"
                      aria-hidden="true"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="2"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                    >
                      <path d="m9 6 6 6-6 6" />
                    </svg>
                  </span>
                </a>
              </li>
            {/each}
          </ul>
        </section>
      {/each}
    {/if}
  </div>
</main>

<style>
  main {
    height: 100%;
    overflow-y: auto;
  }
  .wrap {
    max-width: 960px;
    margin: 0 auto;
    padding: 32px 16px 48px;
  }
  h1 {
    margin: 0;
    font-size: 28px;
    font-weight: 700;
    letter-spacing: -0.02em;
  }
  .lede {
    margin: 6px 0 28px;
    color: var(--muted);
    font-size: 15px;
  }
  section {
    margin-bottom: 28px;
  }
  h2 {
    margin: 0 0 10px;
    font-size: 18px;
    font-weight: 600;
  }
  h2 span {
    margin-left: 8px;
    color: var(--muted);
    font-size: 13px;
    font-weight: 400;
  }
  ul {
    margin: 0;
    padding: 0;
    overflow: hidden;
    border: 1px solid var(--surface3);
    border-radius: 10px;
    list-style: none;
  }
  li + li {
    border-top: 1px solid var(--surface3);
  }
  a {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px 20px;
    min-height: 64px;
    padding: 12px 16px;
    background: var(--surface2);
    color: var(--text);
    text-decoration: none;
  }
  a:hover {
    background: var(--surface);
  }
  .what {
    flex: 1 1 220px;
    min-width: 0;
  }
  .name {
    font-size: 16px;
    font-weight: 600;
  }
  .meta {
    margin-top: 2px;
    color: var(--muted);
    font-size: 13px;
  }
  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .chip {
    padding: 3px 9px;
    border-radius: 999px;
    background: var(--surface3);
    color: var(--text2);
    font-size: 12px;
    font-weight: 600;
  }
  .chip.strong {
    color: var(--text);
  }
  .open {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    color: var(--accent);
    font-weight: 600;
  }
  .note {
    color: var(--muted);
    font-size: 18px;
  }
  @media (max-width: 699px) {
    .wrap {
      padding: 20px 12px 32px;
    }
    h1 {
      font-size: 24px;
    }
    .open {
      display: none;
    }
  }
</style>
