<script lang="ts">
  import { onMount } from 'svelte';
  import { analyse } from '$shared/analysis';
  import type { Score } from '$shared/accuracy';
  import Board from '../components/Board.svelte';
  import EnginePanel from '../components/EnginePanel.svelte';
  import EvalBar from '../components/EvalBar.svelte';
  import EvalGraph from '../components/EvalGraph.svelte';
  import MoveList from '../components/MoveList.svelte';
  import PlayerBar from '../components/PlayerBar.svelte';
  import { LiveStore } from '$lib/live.svelte';
  import { clockOf, positionOf, type Position } from '$lib/position';
  import { play } from '$shared/viewer';

  const store = new LiveStore();
  onMount(() => store.connect());

  const snap = $derived(store.snap);
  const game = $derived(snap?.game ?? null);
  const analysis = $derived(game && analyse(game.plies));
  const position = $derived(game && positionOf(game.plies));
  // Live search first; else the latest stored eval (a finished game's last position has none).
  const score = $derived<Score | null>(
    snap?.live?.lines[0]?.score ?? game?.plies.findLast((p) => p.eval)?.eval?.score ?? null,
  );

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
  <main class="message">Nothing live right now</main>
{:else}
  <main class="viewer">
    <div class="boardCol">
      <EvalBar score={exploring ? null : score} />
      <div class="stack">
        <PlayerBar
          player={game.black}
          clock={clockOf(game.plies, 'black')}
          accuracy={analysis.black}
          toMove={snap.site === 'live' && position.turn === 'black'}
        />
        <Board position={exploring?.position ?? position} {onMove} />
        <PlayerBar
          player={game.white}
          clock={clockOf(game.plies, 'white')}
          accuracy={analysis.white}
          toMove={snap.site === 'live' && position.turn === 'white'}
        />
      </div>
    </div>
    <aside>
      {#if snap.site === 'finished'}<div class="banner">Game over · {game.result.replace('1/2', '½')}</div>{/if}
      {#if !store.connected}<div class="warn">Reconnecting to server…</div>{/if}
      {#if snap.stream === 'reconnecting'}<div class="warn">Lichess stream reconnecting…</div>{/if}
      {#if exploring}
        <div class="explore" class:moved={liveMoved}>
          {liveMoved ? 'Live game moved' : 'Exploring · no engine'}
          <button onclick={() => (explore = null)}>Back to live</button>
        </div>
      {/if}
      <EnginePanel live={snap.live} fen={position.fen} />
      <EvalGraph plies={game.plies} live={snap.live?.lines[0]?.score ?? null} />
      <MoveList plies={game.plies} marks={analysis.marks} />
      <p class="from">
        {analysis.fromMove === null ? 'Accuracy: no scored moves yet' : `Accuracy from move ${analysis.fromMove}`}
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
