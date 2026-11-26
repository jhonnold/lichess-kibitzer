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
  import { LiveStore } from '$lib/live.svelte';
  import { clockOf, positionOf, type Position } from '$lib/position';
  import {
    boardState,
    countdown,
    formatResult,
    panelInfo,
    play,
    selectedBoard,
    statusLine,
    viewerMessage,
  } from '$shared/viewer';

  const { board }: { board: number | null } = $props();

  const store = new LiveStore();
  let now = $state(Date.now());
  onMount(() => {
    const tick = setInterval(() => (now = Date.now()), 1000);
    const disconnect = store.connect();
    return () => (clearInterval(tick), disconnect());
  });

  const snap = $derived(store.snap);
  const boards = $derived(snap?.round?.boards ?? []);
  const game = $derived(selectedBoard(boards, board));
  const notTracked = $derived(board !== null && !!game && game.board !== board);
  const analysis = $derived(game && analyse(game.plies));
  const position = $derived(game && positionOf(game.plies));
  const bState = $derived(game && boardState(game));
  const upcoming = $derived(bState === 'upcoming');
  const live = $derived(bState === 'live');
  const startsIn = (startsAt: number | null) => {
    const left = countdown(startsAt, now);
    return left === null ? 'starts when Lichess reports it live' : left === 'starting' ? left : `starts in ${left}`;
  };
  const status = $derived(game && statusLine(game, game.plies.length - 1, snap?.search ?? null, snap!.queue));
  const panel = $derived(game && panelInfo(game, snap?.search ?? null));
  const panelFen = $derived(panel && game && positionOf(game.plies.slice(0, panel.ply + 1)).fen);
  // The running search's score only while it is for this Board's latest position; else the latest stored eval.
  const liveScore = $derived<Score | null>(panel?.searching ? (panel.lines[0]?.score ?? null) : null);
  const score = $derived<Score | null>(liveScore ?? game?.plies.findLast((p) => p.eval)?.eval?.score ?? null);
  const clock = (color: 'white' | 'black') => (game && (clockOf(game.plies, color) ?? game.clocks[color])) ?? null;

  // The Viewer's own line, local to this tab. Live updates don't move the board meanwhile; a new game drops it.
  let explore = $state.raw<{ gameId: string; plies: number; position: Position } | null>(null);
  const exploring = $derived(explore && explore.gameId === game?.id ? explore : null);
  const liveMoved = $derived(!!exploring && exploring.plies !== game?.plies.length);

  function onMove(from: string, to: string) {
    if (!game || !position) return;
    const base = exploring ?? { gameId: game.id, plies: game.plies.length, position };
    explore = { ...base, position: play(base.position.fen, [{ from, to, promotion: 'q' }]) };
  }
</script>

{#if !snap}
  <main class="message">{store.connected ? 'Loading…' : 'Connecting…'}</main>
{:else if !game || !analysis || !position}
  <main class="message">{viewerMessage(snap) ?? 'Nothing live right now'}</main>
{:else}
  <main class="viewer">
    <div class="boardCol">
      <EvalBar score={exploring ? null : score} />
      <div class="stack">
        <PlayerBar
          player={game.black}
          clock={clock('black')}
          accuracy={analysis.black}
          toMove={live && position.turn === 'black'}
        />
        <Board position={exploring?.position ?? position} {onMove} />
        <PlayerBar
          player={game.white}
          clock={clock('white')}
          accuracy={analysis.white}
          toMove={live && position.turn === 'white'}
        />
      </div>
    </div>
    <aside>
      <BoardStrip {boards} selected={game.board} />
      {#if notTracked}<div class="warn">Board {board} is not tracked · showing board {game.board}</div>{/if}
      {#if upcoming}<div class="banner">
          Upcoming · {snap.round?.name} · {startsIn(snap.round?.startsAt ?? null)}
        </div>{/if}
      {#if !upcoming && !live}<div class="banner">Game over · {formatResult(game.result)}</div>{/if}
      {#if !store.connected}<div class="warn">Reconnecting to server…</div>{/if}
      {#if snap.stream === 'reconnecting'}<div class="warn">Lichess stream reconnecting…</div>{/if}
      {#if exploring}
        <div class="explore" class:moved={liveMoved}>
          {liveMoved ? 'Live game moved' : 'Exploring · no engine'}
          <button onclick={() => (explore = null)}>Back to live</button>
        </div>
      {/if}
      <EnginePanel info={panel} fen={panelFen ?? position.fen} {status} />
      <EvalGraph plies={game.plies} live={liveScore} />
      <MoveList plies={game.plies} marks={analysis.marks} />
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
  .explore {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 6px 12px;
    font-size: 18px;
    background: var(--surface);
  }
  .explore.moved {
    color: var(--warn);
  }
  button {
    padding: 6px 14px;
    border: 0;
    font: inherit;
    font-weight: 700;
    color: var(--bg);
    background: var(--accent);
    cursor: pointer;
  }
  .from {
    margin: auto 0 0;
    padding: 6px 12px;
    color: var(--muted);
    background: var(--surface);
  }
</style>
