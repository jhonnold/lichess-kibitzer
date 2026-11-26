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
  import type { SnapSource } from '$lib/live.svelte';
  import type { ArchiveCtx } from '$shared/archive';
  import { clockOf } from '$lib/position';
  import {
    back,
    cursorNote,
    cursorView,
    forward,
    jump,
    liveCursor,
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
    panelInfo,
    selectedBoard,
    statusLine,
    viewerMessage,
  } from '$shared/viewer';

  // ctx: set for an archived Round, which switches the live-only UI off.
  const { store, board, ctx = null }: { store: SnapSource; board: number | null; ctx?: ArchiveCtx | null } = $props();

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
  const clock = (color: 'white' | 'black') =>
    (game && view && (clockOf(game.plies.slice(0, view.ply + 1), color) ?? game.clocks[color])) ?? null;

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
  // No panel (own moves, a ply without lines) → no arrows.
  const shapes = $derived(showArrows && panel && view ? arrows(panel.lines, view.position.turn) : []);

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
    if (e.key === 'a' || e.key === 'A') {
      showArrows = !showArrows;
      try {
        localStorage.setItem(ARROWS_KEY, showArrows ? '1' : '0');
      } catch {
        // storage unavailable: the choice lasts until reload
      }
      return;
    }
    if (!view) return;
    const c = view.cursor;
    const next =
      e.key === 'ArrowLeft'
        ? back(c, view.latest)
        : e.key === 'ArrowRight'
          ? forward(c, view.latest)
          : e.key === 'Home'
            ? jump(c, 0, view.latest)
            : e.key === 'End'
              ? toLive(c)
              : null;
    if (!next) return;
    e.preventDefault();
    cursor = next;
  }
</script>

<svelte:window onkeydown={onKey} />

{#if !snap}
  <main class="message">{store.connected ? 'Loading…' : 'Connecting…'}</main>
{:else if !game || !analysis || !view || !bar}
  <main class="message">{viewerMessage(snap) ?? 'Nothing live right now'}</main>
{:else}
  <main class="viewer">
    <div class="boardCol">
      <EvalBar score={bar.score} dim={bar.dim || view.inBranch} />
      <div class="stack">
        <PlayerBar
          player={game.black}
          clock={clock('black')}
          accuracy={analysis.black}
          toMove={!ctx && live && view.live && view.position.turn === 'black'}
        />
        <Board
          position={view.position}
          arrows={shapes}
          onMove={(from, to) => (cursor = playOwn(view.cursor, from + to, view.latest))}
        />
        <PlayerBar
          player={game.white}
          clock={clock('white')}
          accuracy={analysis.white}
          toMove={!ctx && live && view.live && view.position.turn === 'white'}
        />
      </div>
    </div>
    <aside>
      <BoardStrip {boards} selected={game.board} {ctx} />
      {#if notTracked}<div class="warn">Board {board} is not tracked · showing board {game.board}</div>{/if}
      {#if ctx}<div class="banner">
          Archive · {snap.event?.name} · {snap.round?.name} · {archivedResult(game)}
        </div>{:else}
        {#if upcoming}<div class="banner">
            Upcoming · {snap.round?.name} · {startsIn(snap.round?.startsAt ?? null)}
          </div>{/if}
        {#if !upcoming && !live}<div class="banner">Game over · {formatResult(game.result)}</div>{/if}
        {#if !store.connected}<div class="warn">Reconnecting to server…</div>{/if}
        {#if snap.stream === 'reconnecting'}<div class="warn">Lichess stream reconnecting…</div>{/if}
      {/if}
      {#if !view.live}
        <div class="cursor" class:moved={view.behind > 0}>
          <span>{cursorNote(view, game.plies, !!ctx)}</span>
          <button onclick={() => (cursor = toLive(view.cursor))}>{ctx ? 'End' : 'Back to live'}</button>
        </div>
      {/if}
      <EnginePanel info={panel} fen={view.position.fen} status={ctx ? null : status} />
      <EvalGraph
        plies={game.plies}
        live={liveScore}
        cursor={view.live ? null : view.ply}
        onJump={(n) => (cursor = jump(view.cursor, n, view.latest))}
      />
      <MoveList
        plies={game.plies}
        marks={analysis.marks}
        cursor={view.ply}
        follow={view.live}
        onJump={(n) => (cursor = jump(view.cursor, n, view.latest))}
      />
      <p class="from">
        {analysis.scored === 0
          ? 'Accuracy: no scored moves yet'
          : `Accuracy: ${analysis.scored} of ${analysis.total} moves scored`}
      </p>
    </aside>
  </main>
{/if}

<style>
  main {
    height: 100vh;
  }
  .message {
    display: grid;
    place-items: center;
    font-size: 32px;
    color: var(--muted);
  }
  .viewer {
    --gap: 16px;
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    grid-template-rows: minmax(0, 1fr);
    gap: var(--gap);
    padding: var(--gap);
  }
  .boardCol {
    display: flex;
    gap: 8px;
  }
  /* Square board as large as the screen allows, with room for two player bars and the side panel. */
  .stack {
    width: min(calc(100vh - 2 * var(--barH) - 2 * var(--gap)), calc(100vw - 560px));
  }
  aside {
    display: flex;
    flex-direction: column;
    min-height: 0;
    background: var(--surface2);
  }
  .banner,
  .warn {
    padding: 10px 12px;
    font-size: 20px;
    font-weight: 700;
  }
  .banner {
    background: var(--accent);
    color: var(--bg);
  }
  .warn {
    background: var(--warn);
    color: var(--bg);
  }
  .cursor {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 6px 12px;
    font-size: 18px;
    background: var(--surface);
  }
  .cursor.moved {
    color: var(--warn);
  }
  button {
    padding: 6px 14px;
    border: 0;
    font: inherit;
    font-weight: 700;
    color: var(--bg);
    background: var(--accent);
    white-space: nowrap;
    cursor: pointer;
  }
  .from {
    margin: auto 0 0;
    padding: 6px 12px;
    color: var(--muted);
    background: var(--surface);
  }
</style>
