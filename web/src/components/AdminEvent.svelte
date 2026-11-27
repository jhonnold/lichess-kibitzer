<script lang="ts">
  import type { AdminEventStatus } from '$lib/admin-api';
  import { formatResult, countdown } from '$shared/viewer';

  type Props = {
    ev: AdminEventStatus;
    busy: boolean;
    now: number;
    topN: string; // bindable, owned by Admin (keyed by tourId) so a status refresh does not reset typed input
    checked: string[];
    onTopN: () => void;
    onTracked: () => void;
    onPrimary: () => void;
    onRemove: () => void;
  };
  /* eslint-disable prefer-const -- topN and checked are bindable */
  let {
    ev,
    busy,
    now,
    topN = $bindable(),
    checked = $bindable(),
    onTopN,
    onTracked,
    onPrimary,
    onRemove,
  }: Props = $props();
  /* eslint-enable prefer-const */

  const ago = (ms: number) =>
    `${new Date(ms).toLocaleTimeString()} · ${Math.max(0, Math.round((now - ms) / 1000))} s ago`;
  const when = (ms: number) => {
    const left = countdown(ms, now);
    return `${new Date(ms).toLocaleString()}${left === 'starting' ? '' : ` · in ${left}`}`;
  };
  const trackedNow = $derived(ev.round?.boards.filter((b) => b.tracked).length ?? 0);
  const confirmRemove = () => {
    if (confirm(`Remove ${ev.event.name}? It stops polling the Event and drops its Jobs.`)) onRemove();
  };
</script>

<article class="ev" data-tour={ev.event.tourId}>
  <header>
    <a class="name" href={ev.event.link}>{ev.event.name}</a>
    {#if ev.primary}
      <span class="chip">Primary</span>
    {:else}
      <button type="button" disabled={busy} onclick={onPrimary}>Make Primary</button>
    {/if}
    <span class="fill"></span>
    <button type="button" class="dangerBtn" disabled={busy} onclick={confirmRemove}>Remove</button>
  </header>
  <p class="muted small">Remove stops polling this Event and drops its Jobs.</p>

  <div class="facts">
    <p>
      Current Round <b>{ev.round?.name ?? '–'}</b>
      {#if ev.round}· {trackedNow} of {ev.round.boards.length} tracked{/if}
    </p>
    <p class="dotrow">
      <i class={ev.stream === 'connected' ? 'ok' : ev.stream === 'reconnecting' ? 'warn' : ''}></i>Lichess stream
      <b>{ev.stream ?? '–'}</b>
    </p>
    <p>Last poll <b>{ev.follow.polledAt === null ? '–' : ago(ev.follow.polledAt)}</b></p>
    {#if ev.follow.next}
      <p>Next Round <b>{ev.follow.next.name}</b></p>
      <p class="muted">
        Starts {ev.follow.next.startsAt === null ? 'when Lichess reports it' : when(ev.follow.next.startsAt)}
      </p>
      <p>Swap <b>{ev.follow.swapAt === null ? 'when Lichess reports it live' : when(ev.follow.swapAt)}</b></p>
    {:else}
      <p>Next Round <b>– (last Round)</b></p>
    {/if}
    {#if ev.follow.error}<p class="error">{ev.follow.error}</p>{/if}
  </div>

  <form class="inline" onsubmit={(e) => (e.preventDefault(), onTopN())}>
    <label class="field">
      <span>Tracked boards in the next Round (top N)</span>
      <input type="number" min="1" max="64" step="1" required bind:value={topN} />
    </label>
    <button disabled={busy}>Save</button>
  </form>

  {#if ev.round}
    <form onsubmit={(e) => (e.preventDefault(), onTracked())}>
      <details open={ev.round.boards.length <= 16}>
        <summary>Tracked boards in this Round ({checked.length} of {ev.round.boards.length})</summary>
        <div class="boards">
          {#each ev.round.boards as b (b.id)}
            <label class="check">
              <input type="checkbox" value={b.id} bind:group={checked} />
              <span class="n">{b.board}</span>
              <span class="names">{b.white.name} – {b.black.name}</span>
              <span class="muted">{formatResult(b.result)}</span>
            </label>
          {/each}
        </div>
      </details>
      <div class="actions">
        <button disabled={busy}>Save tracked boards</button>
        <small class="muted">Applies to this Round only</small>
      </div>
    </form>
  {:else}
    <p class="muted">No Current Round</p>
  {/if}
</article>

<style>
  p {
    margin: 0;
  }
  .ev {
    display: flex;
    flex-direction: column;
    gap: 12px;
    min-width: 0;
    padding: 16px;
    border: 1px solid var(--surface3);
    border-radius: 10px;
    background: var(--surface2);
  }
  header {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px 12px;
  }
  .name {
    color: var(--accent);
    font-size: 16px;
    font-weight: 700;
  }
  .fill {
    flex: 1 1 0;
  }
  .chip {
    padding: 2px 10px;
    border-radius: 999px;
    background: var(--accentBg);
    color: var(--accent);
    font-size: 12px;
    font-weight: 700;
  }
  .muted {
    color: var(--muted);
  }
  .small {
    font-size: 13px;
  }
  .error {
    color: var(--blunder);
  }
  .facts {
    display: flex;
    flex-direction: column;
    gap: 4px;
    color: var(--text2);
  }
  .facts b {
    color: var(--text);
  }
  .dotrow {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .dotrow b {
    margin-left: auto;
  }
  i {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--muted);
  }
  i.ok {
    background: var(--ok);
  }
  i.warn {
    background: var(--warn);
  }
  input[type='number'] {
    min-height: 40px;
    padding: 0 12px;
    border: 1px solid var(--line);
    border-radius: var(--radiusS);
    background: var(--bg);
    color: var(--text);
    font: inherit;
  }
  input[type='number']:focus {
    border-color: var(--accent);
    outline: none;
  }
  input[type='checkbox'] {
    width: 18px;
    min-height: 18px;
    margin: 0;
    accent-color: var(--accent);
  }
  button {
    min-height: 40px;
    padding: 0 16px;
    border: 1px solid var(--line);
    border-radius: var(--radiusS);
    background: var(--surface);
    color: var(--text);
    font: 600 14px var(--fontUi);
    white-space: nowrap;
    cursor: pointer;
  }
  button:hover:not(:disabled) {
    border-color: var(--muted);
  }
  button:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .dangerBtn {
    border-color: var(--blunder);
    background: none;
    color: var(--liveText);
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: 6px;
    min-width: 0;
  }
  .field > span,
  summary {
    color: var(--text2);
    font-size: 13px;
    font-weight: 600;
  }
  summary {
    cursor: pointer;
  }
  .inline {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-end;
    gap: 8px;
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 12px;
    margin-top: 12px;
  }
  .boards {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
    gap: 4px 16px;
    margin-top: 8px;
  }
  .check {
    display: flex;
    align-items: center;
    gap: 10px;
    min-height: 40px;
    min-width: 0;
    cursor: pointer;
  }
  .check > :last-child {
    flex: none;
    white-space: nowrap;
  }
  .check .n {
    font: 600 12px var(--fontMono);
    color: var(--accent);
  }
  .check .names {
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  @media (max-width: 699px) {
    .ev {
      padding: 12px;
    }
    .inline > button {
      flex: 1 1 auto;
      min-height: 44px;
    }
    input[type='number'] {
      min-height: 44px;
    }
  }
</style>
