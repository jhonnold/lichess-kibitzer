<script lang="ts">
  import { onMount } from 'svelte';
  import { analyse } from '$shared/analysis';
  import type { Score } from '$shared/accuracy';
  import Board from '../components/Board.svelte';
  import EnginePanel from '../components/EnginePanel.svelte';
  import EvalBar from '../components/EvalBar.svelte';
  import EvalGraph from '../components/EvalGraph.svelte';
  import MoveList from '../components/MoveList.svelte';
  import BoardStrip from '../components/BoardStrip.svelte';
  import PlayerBar from '../components/PlayerBar.svelte';
  import { arrows } from '$shared/arrows';
  import { archiveHash, boardHash, homeHash, type Layout } from '$shared/route';
  import type { SnapSource } from '$lib/live.svelte';
  import type { ArchiveCtx } from '$shared/archive';
  import { clockOf } from '$lib/position';
  import type { Color } from '$shared/accuracy';
  import { material } from '$shared/material';
  import {
    back,
    cursorNote,
    cursorView,
    forward,
    jump,
    liveCursor,
    moveNumber,
    playOwn,
    toLive,
    type Cursor,
  } from '$shared/cursor';
  import {
    barScore,
    boardState,
    countdown,
    archivedResult,
    formatResult,
    lichessUrl,
    panelInfo,
    selectedBoard,
    statusLine,
    tickingClock,
    viewerMessage,
  } from '$shared/viewer';

  // ctx: set for an archived Round, which switches the live-only UI off. ply: deep link into the game.
  // layout: streaming params; query: the hash's `?…` part, which every link and URL update keeps.
  type Props = {
    store: SnapSource;
    board: number | null;
    ply?: number | null;
    layout: Layout;
    query?: string;
    ctx?: ArchiveCtx | null;
    tourId?: string | null; // the route's Event (null = the Primary); live Viewer only
  };
  const { store, board, ply = null, layout, query = '', ctx = null, tourId = null }: Props = $props();

  let now = $state(Date.now());
  onMount(() => {
    const tick = setInterval(() => (now = Date.now()), 1000);
    return () => clearInterval(tick);
  });

  const snap = $derived(store.snap);
  const boards = $derived(snap?.round?.boards ?? []);
  const game = $derived(selectedBoard(boards, board));
  const notTracked = $derived(board !== null && !!game && game.board !== board);
  const analysis = $derived(game && analyse(game.plies));
  const bState = $derived(game && boardState(game));
  const upcoming = $derived(bState === 'upcoming');
  const live = $derived(bState === 'live');
  const startsIn = (startsAt: number | null) => {
    const left = countdown(startsAt, now);
    return left === null ? 'starts when Lichess reports it live' : left === 'starting' ? left : `starts in ${left}`;
  };

  // Where the Viewer is in the game. Every normalisation (other Board, retraction, landing on the latest ply) is
  // persisted, so a retract-then-append keeps following; cursorView returns the same object when nothing changed.
  let cursor = $state.raw<Cursor>(liveCursor(''));
  const view = $derived(game && cursorView(cursor, game));
  $effect(() => {
    if (view && view.cursor !== cursor) cursor = view.cursor;
  });

  // The route's ply moves the Cursor only when the route changes (not when the Cursor moves the URL).
  let applied = '';
  $effect(() => {
    if (!game) return;
    const key = `${game.id}/${ply}`;
    if (key === applied) return;
    applied = key;
    if (ply !== null) cursor = jump(liveCursor(game.id), ply, game.plies.length - 1);
  });
  // The URL follows the Cursor (replaceState: no history entries, no hashchange). Live = no ply. The route's Board
  // number is kept (`#/` stays the default Board, an untracked n stays n).
  $effect(() => {
    if (!game || !view || applied !== `${game.id}/${ply}`) return;
    const p = view.live ? undefined : view.ply;
    const n = board ?? game.board;
    const want =
      (ctx
        ? archiveHash(ctx.tourId, ctx.roundId, n, p)
        : board === null && view.live
          ? homeHash(tourId)
          : boardHash(n, p, tourId)) + query;
    if (location.hash !== want) history.replaceState(null, '', want);
  });

  const status = $derived(
    game && view && snap
      ? view.evalPly === null
        ? { state: 'none' as const, text: 'Your moves · no engine' }
        : statusLine(game, view.evalPly, snap.search, snap.queue)
      : null,
  );
  const panel = $derived(
    game && view && view.evalPly !== null ? panelInfo(game, view.evalPly, snap?.search ?? null) : null,
  );
  const bar = $derived(game && view && barScore(game, view.ply, snap?.search ?? null));
  // The graph's last point shows the running search's score while it is for the latest ply.
  const liveScore = $derived<Score | null>(
    game && view && snap?.search?.boardId === game.id && snap.search.ply === view.latest
      ? (snap.search.lines[0]?.score ?? null)
      : null,
  );
  // Only a Live Board's clock on the live Cursor ticks (not in the Archive); `now` is server time.
  const ticking = $derived(!ctx && live && !!view?.live);
  const clock = (color: Color) =>
    game && view
      ? view.live
        ? tickingClock(game, color, ticking, now - store.skew)
        : (clockOf(game.plies.slice(0, view.ply + 1), color) ?? game.clocks[color])
      : null;
  const mat = $derived(view && material(view.position.fen));
  const toMove = (color: Color) => !ctx && live && !!view?.live && view.position.turn === color;

  const ARROWS_KEY = 'kibitzer.arrows';
  let showArrows = $state(
    (() => {
      try {
        return localStorage.getItem(ARROWS_KEY) !== '0';
      } catch {
        return true;
      }
    })(),
  );
  const arrowsOn = $derived(layout.arrows ?? showArrows);
  // No panel (own moves, a ply without lines) → no arrows.
  const shapes = $derived(arrowsOn && panel && view ? arrows(panel.lines, view.position.turn, panel.main) : []);

  const FLIP_KEY = 'kibitzer.flip';
  let flipped = $state(
    (() => {
      try {
        return localStorage.getItem(FLIP_KEY) === '1';
      } catch {
        return false;
      }
    })(),
  );
  const orientation = $derived((layout.flip ?? flipped) ? 'black' : 'white');
  function flip() {
    flipped = !flipped;
    try {
      localStorage.setItem(FLIP_KEY, flipped ? '1' : '0');
    } catch {
      // storage unavailable: the choice lasts until reload
    }
  }

  function onKey(e: KeyboardEvent) {
    const t = e.target as HTMLElement | null;
    if (
      e.altKey ||
      e.ctrlKey ||
      e.metaKey ||
      t?.isContentEditable ||
      /^(INPUT|TEXTAREA|SELECT)$/.test(t?.tagName ?? '')
    )
      return;
    if (e.key === 'f' || e.key === 'F') return flip();
    if (e.key === 'a' || e.key === 'A') return toggleArrows();
    const next = step(e.key);
    if (!next) return;
    e.preventDefault();
    cursor = next;
  }
  function toggleArrows() {
    showArrows = !showArrows;
    try {
      localStorage.setItem(ARROWS_KEY, showArrows ? '1' : '0');
    } catch {
      // storage unavailable: the choice lasts until reload
    }
  }
  /** Where a step key (or its button) moves the Cursor; null for other keys. */
  function step(key: string): Cursor | null {
    if (!view) return null;
    const c = view.cursor;
    return key === 'ArrowLeft'
      ? back(c, view.latest)
      : key === 'ArrowRight'
        ? forward(c, view.latest)
        : key === 'Home'
          ? jump(c, 0, view.latest)
          : key === 'End'
            ? toLive(c)
            : null;
  }
  const go = (key: string) => {
    const next = step(key);
    if (next) cursor = next;
  };

  // Phone: one panel card group at a time.
  type Pane = 'engine' | 'moves' | 'game';
  let pane = $state<Pane>('engine');
  const PANES: [Pane, string][] = [
    ['engine', 'Engine'],
    ['moves', 'Moves'],
    ['game', 'Game'],
  ];
</script>

<svelte:window onkeydown={onKey} />

{#snippet stepButtons(big: boolean)}
  <div class="steps" class:big>
    {#each [['Home', 'First move', 'M6 5v14M18 6l-8 6 8 6z'], ['ArrowLeft', 'Previous move', 'M15 6l-6 6 6 6'], ['ArrowRight', 'Next move', 'M9 6l6 6-6 6'], ['End', ctx ? 'Last move' : 'Live', 'M18 5v14M6 6l8 6-8 6z']] as [key, label, d] (key)}
      <button type="button" class="step" aria-label={label} title={label} onclick={() => go(key)}>
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          aria-hidden="true"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <path {d} />
        </svg>
      </button>
    {/each}
  </div>
{/snippet}

{#if !snap}
  <main class="message">{store.connected ? 'Loading…' : 'Connecting…'}</main>
{:else if !game || !analysis || !view || !bar}
  <main class="message">{viewerMessage(snap) ?? 'Nothing live right now'}</main>
{:else}
  {#snippet playerBar(color: Color)}
    <PlayerBar
      player={game[color]}
      {color}
      clock={clock(color)}
      accuracy={analysis[color]}
      toMove={toMove(color)}
      material={mat![color]}
    />
  {/snippet}
  {@const note = view.live
    ? view.latest === 0
      ? 'Start position'
      : `Latest · ${moveNumber(view.latest)} ${game.plies[view.latest].move!.san}`
    : cursorNote(view, game.plies, !!ctx)}
  <main class="viewer" class:nopanel={!layout.panel} class:stream={!layout.chrome}>
    {#if layout.chrome}
      <div class="strip">
        <BoardStrip {boards} selected={game.board} {ctx} {query} {tourId} />
        <div class="tools">
          <button
            type="button"
            class="tool"
            aria-pressed={orientation === 'black'}
            onclick={flip}
            title="Flip board (f)"
          >
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
              <path d="M7 4v16M7 20l-3-3M7 20l3-3M17 20V4M17 4l-3 3M17 4l3 3" />
            </svg>
            Flip<kbd>f</kbd>
          </button>
          <button type="button" class="tool" aria-pressed={arrowsOn} onclick={toggleArrows} title="Engine arrows (a)">
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
              <path d="M5 19 19 5M19 5h-7M19 5v7" />
            </svg>
            Arrows<kbd>a</kbd>
          </button>
          {#if snap.round}
            <a class="tool" href={lichessUrl(snap.round.roundId, game.id)} target="_blank" rel="noopener">
              Open on Lichess
              <svg
                width="12"
                height="12"
                viewBox="0 0 24 24"
                aria-hidden="true"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <path d="M14 4h6v6M20 4l-9 9M18 14v6H4V6h6" />
              </svg>
            </a>
          {/if}
        </div>
      </div>
      {#if notTracked || (!ctx && (upcoming || !store.connected || snap.stream === 'reconnecting'))}
        <div class="banners">
          {#if notTracked}<div class="banner warn">Board {board} is not tracked · showing board {game.board}</div>{/if}
          {#if !ctx}
            {#if upcoming}<div class="banner">
                Upcoming · {snap.round?.name} · {startsIn(snap.round?.startsAt ?? null)}
              </div>{/if}
            {#if !store.connected}<div class="banner warn">Reconnecting to server…</div>{/if}
            {#if snap.stream === 'reconnecting'}<div class="banner warn">Lichess stream reconnecting…</div>{/if}
          {/if}
        </div>
      {/if}
    {/if}

    <div class="body">
      <div class="boardCol">
        <div class="hbar"><EvalBar score={bar.score} dim={bar.dim || view.inBranch} horizontal /></div>
        {@render playerBar(orientation === 'black' ? 'white' : 'black')}
        <div class="boardRow">
          <EvalBar score={bar.score} dim={bar.dim || view.inBranch} flip={orientation === 'black'} />
          <div class="board">
            <Board
              position={view.position}
              arrows={shapes}
              {orientation}
              onMove={(from, to) => (cursor = playOwn(view.cursor, from + to, view.latest))}
            />
          </div>
        </div>
        {@render playerBar(orientation === 'black' ? 'black' : 'white')}
        {#if layout.chrome}
          <div class="phoneSteps">
            <span class="note" class:moved={view.behind > 0}>{note}</span>
            {@render stepButtons(true)}
          </div>
        {/if}
      </div>

      {#if layout.panel}
        <aside class="p-{pane}">
          {#if layout.chrome}
            <div class="panes" role="tablist" aria-label="Panel">
              {#each PANES as [id, label] (id)}
                <button type="button" role="tab" aria-selected={pane === id} onclick={() => (pane = id)}>
                  {label}
                </button>
              {/each}
            </div>
          {/if}

          <section class="card head" data-pane="game">
            <div class="title">
              <h1>{ctx ? 'Archived' : upcoming ? 'Upcoming' : live ? 'Live' : 'Game over'}</h1>
              {#if ctx}<span class="result" class:word={game.result === '*'}>
                  {archivedResult(game)}
                </span>{:else if !upcoming && !live}<span class="result">
                  {formatResult(game.result)}
                </span>{/if}
            </div>
            {#if status && !ctx}
              <span class="pill {status.state}"><i></i>{status.text}</span>
            {/if}
            {#if game.opening}<p class="opening" title={game.opening}>{game.opening}</p>{/if}
          </section>

          <div data-pane="engine"><EnginePanel info={panel} fen={view.position.fen} /></div>

          <section class="card graph" data-pane="game" aria-label="Evaluation graph">
            <EvalGraph
              plies={game.plies}
              live={liveScore}
              cursor={view.live ? null : view.ply}
              onJump={(n) => (cursor = jump(view.cursor, n, view.latest))}
            />
          </section>

          <section class="card moves" data-pane="moves" aria-label="Moves">
            <header>
              <h2>Moves</h2>
              {#if layout.chrome}
                <span>
                  {analysis.scored === 0
                    ? 'Accuracy: no scored moves yet'
                    : `Accuracy: ${analysis.scored} of ${analysis.total} moves scored`}
                </span>
              {/if}
            </header>
            <MoveList
              plies={game.plies}
              marks={analysis.marks}
              cursor={view.ply}
              follow={view.live}
              onJump={(n) => (cursor = jump(view.cursor, n, view.latest))}
            />
            {#if layout.chrome}
              <footer>
                {@render stepButtons(false)}
                <span class="note" class:moved={view.behind > 0}>{note}</span>
                {#if !view.live}
                  <button type="button" class="live" onclick={() => (cursor = toLive(view.cursor))}>
                    {ctx ? 'End' : 'Back to live'}
                  </button>
                {/if}
                <span class="keys" aria-hidden="true"><kbd>←</kbd><kbd>→</kbd><kbd>Home</kbd><kbd>End</kbd></span>
              </footer>
            {/if}
          </section>
        </aside>
      {/if}
    </div>
  </main>
{/if}

<style>
  main {
    height: 100%;
  }
  .message {
    display: grid;
    place-items: center;
    padding: 16px;
    font-size: 24px;
    color: var(--muted);
    text-align: center;
  }

  /* Desktop (≥1100px): board beside the panel, one screen high. */
  .viewer {
    --panelMin: 400px;
    display: flex;
    flex-direction: column;
  }
  .strip {
    display: grid;
    flex: none;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: start;
    gap: 8px 12px;
    padding: 8px 16px;
    border-bottom: 1px solid var(--surface3);
  }
  .tools {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .tool {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    min-height: 32px;
    padding: 0 10px;
    border: 1px solid var(--line);
    border-radius: var(--radiusS);
    background: var(--surface2);
    color: var(--text);
    font: 500 13px var(--fontUi);
    text-decoration: none;
    white-space: nowrap;
    cursor: pointer;
  }
  .tool:hover {
    border-color: var(--muted);
  }
  .tool[aria-pressed='true'] {
    border-color: var(--accent);
  }
  .banners {
    display: flex;
    flex: none;
    flex-direction: column;
    gap: 6px;
    padding: 8px 16px 0;
  }
  .banner {
    padding: 8px 12px;
    border-left: 3px solid var(--accent);
    border-radius: var(--radiusS);
    background: var(--accentBg);
    font-weight: 600;
  }
  .banner.warn {
    border-left-color: var(--warn);
    background: var(--warnBg);
  }
  .body {
    display: flex;
    flex: 1 1 0;
    gap: 16px;
    min-height: 0;
    padding: 12px 16px;
    container-type: size;
  }
  .boardCol {
    --boardW: min(calc(100cqh - 2 * var(--barH)), calc(100cqw - 34px - 16px - var(--panelMin)));
    display: flex;
    flex: none;
    flex-direction: column;
  }
  .nopanel .body {
    justify-content: center;
  }
  .nopanel .boardCol {
    --boardW: min(calc(100cqh - 2 * var(--barH)), calc(100cqw - 34px));
  }
  .boardCol > :global(.player) {
    padding-left: 34px;
  }
  .boardRow {
    display: flex;
    gap: 10px;
  }
  .board {
    width: var(--boardW);
  }
  .hbar,
  .phoneSteps,
  .panes {
    display: none;
  }
  aside {
    display: flex;
    flex: 1 1 0;
    flex-direction: column;
    gap: 12px;
    min-width: 0;
    min-height: 0;
    overflow-y: auto;
  }
  .card {
    border-radius: var(--radius);
    background: var(--surface);
  }
  .head {
    display: flex;
    flex: none;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px 16px;
    padding: 14px 16px;
  }
  .title {
    display: flex;
    flex: 1 1 auto;
    align-items: baseline;
    gap: 10px;
  }
  h1 {
    margin: 0;
    font-size: 20px;
    font-weight: 700;
    letter-spacing: -0.01em;
  }
  .result {
    font: 600 20px var(--fontMono);
  }
  .result.word {
    color: var(--muted);
    font: 500 15px var(--fontUi);
  }
  .pill {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 3px 10px;
    border-radius: 999px;
    background: var(--surface2);
    color: var(--text2);
    font-size: 12px;
    font-weight: 600;
  }
  .pill i {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--muted);
  }
  .pill.searching {
    color: var(--accent);
  }
  .pill.searching i {
    background: var(--accent);
  }
  .pill.queued i {
    background: var(--warn);
  }
  .pill.none i {
    background: transparent;
    box-shadow: inset 0 0 0 1px var(--muted);
  }
  .opening {
    flex-basis: 100%;
    margin: 0;
    overflow: hidden;
    color: var(--muted);
    font-size: 13px;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  [data-pane='engine'] {
    flex: none;
  }
  .graph {
    flex: none;
    padding: 10px 16px 12px;
  }
  .moves {
    display: flex;
    flex: 1 1 0;
    flex-direction: column;
    min-height: 180px;
    overflow: hidden;
  }
  .moves header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 10px 16px 6px;
  }
  h2 {
    margin: 0;
    font-size: 12px;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--muted);
  }
  .moves header span {
    font-size: 12px;
    color: var(--muted);
  }
  footer {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px 10px;
    padding: 8px 12px;
    border-top: 1px solid var(--surface3);
  }
  .note {
    min-width: 0;
    overflow: hidden;
    color: var(--muted);
    font-size: 13px;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .note.moved {
    color: var(--warn);
  }
  .live {
    min-height: 28px;
    padding: 0 12px;
    border: 0;
    border-radius: var(--radiusS);
    background: var(--accent);
    color: var(--onLight);
    font: 600 13px var(--fontUi);
    cursor: pointer;
  }
  .keys {
    display: inline-flex;
    gap: 4px;
    margin-left: auto;
  }
  .steps {
    display: flex;
    gap: 4px;
  }
  .step {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 28px;
    border: 1px solid var(--line);
    border-radius: var(--radiusS);
    background: var(--surface2);
    color: var(--text);
    cursor: pointer;
  }
  .step:hover {
    border-color: var(--muted);
  }
  .steps.big .step {
    width: 44px;
    height: 44px;
  }

  /* Stream layout (?chrome=0): no navigation, a little more room. */
  .stream .body {
    padding: 16px;
  }

  /* Tablet (700–1099px): board on top, cards below; the page scrolls. */
  @media (max-width: 1099px) {
    .viewer {
      overflow-y: auto;
    }
    .strip {
      grid-template-columns: minmax(0, 1fr);
    }
    .strip > :global(nav) {
      margin: 0 -16px;
      padding: 0 16px;
    }
    .body {
      flex: none;
      flex-direction: column;
      align-items: center;
      container-type: inline-size;
    }
    .boardCol {
      --boardW: min(calc(100cqw - 34px), 720px);
    }
    .nopanel .boardCol {
      --boardW: min(calc(100cqw - 34px), calc(100dvh - 2 * var(--barH) - 160px));
    }
    aside {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
      align-items: start;
      width: 100%;
      overflow: visible;
    }
    .head {
      grid-column: 1 / -1;
    }
    .moves {
      height: 360px;
    }
  }

  /* Phone (<700px): full-width board, a horizontal eval bar, one panel group at a time, big step buttons. */
  @media (max-width: 699px) {
    .strip {
      padding: 8px 12px;
    }
    .strip > :global(nav) {
      margin: 0 -12px;
      padding: 0 12px;
    }
    .tool kbd {
      display: none;
    }
    .banners {
      padding: 8px 12px 0;
    }
    .body {
      gap: 8px;
      padding: 8px 12px 12px;
    }
    .boardCol {
      --boardW: 100cqw;
      width: 100%;
    }
    .boardCol > :global(.player) {
      padding-left: 0;
    }
    .boardRow > :global(.bar) {
      display: none;
    }
    .hbar {
      display: block;
      margin-top: 4px;
    }
    .phoneSteps {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding-top: 8px;
    }
    .stream .phoneSteps {
      display: none;
    }
    aside {
      grid-template-columns: minmax(0, 1fr);
      gap: 8px;
    }
    .panes {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 2px;
      padding: 3px;
      border-radius: var(--radius);
      background: var(--surface2);
    }
    .panes button {
      min-height: 40px;
      border: 0;
      border-radius: var(--radiusS);
      background: none;
      color: var(--muted);
      font: 600 14px var(--fontUi);
      cursor: pointer;
    }
    .panes button[aria-selected='true'] {
      background: var(--surface);
      color: var(--text);
    }
    aside.p-engine > [data-pane]:not([data-pane='engine']),
    aside.p-moves > [data-pane]:not([data-pane='moves']),
    aside.p-game > [data-pane]:not([data-pane='game']) {
      display: none;
    }
    footer {
      display: none;
    }
    .moves {
      height: 50dvh;
    }
  }
</style>
