<script lang="ts">
  import { winPercent, type Score } from '$shared/accuracy';
  import { formatScore } from '$lib/format';

  // flip: White's part at the top (Black at the bottom of the board).
  type Props = { score: Score | null; dim?: boolean; flip?: boolean };
  const { score, dim = false, flip = false }: Props = $props();

  const white = $derived(score ? winPercent(score) : 50);
  const label = $derived(score ? formatScore(score) : '');
</script>

<div class="bar" class:dim class:flip role="img" aria-label={score ? `Evaluation ${label} for White` : 'No evaluation'}>
  <div class="white" style:height="{white}%"></div>
  <span class:top={white < 50 !== flip} class:light={white < 50}>{label}</span>
</div>

<style>
  .bar {
    position: relative;
    display: flex;
    flex-direction: column-reverse;
    width: 40px;
    background: var(--evalB);
  }
  .flip {
    flex-direction: column;
  }
  .dim {
    opacity: 0.45;
  }
  .white {
    background: var(--evalW);
    transition: height 0.3s;
  }
  span {
    position: absolute;
    bottom: 4px;
    width: 100%;
    text-align: center;
    font: 600 11px var(--fontMono);
    color: var(--evalB);
  }
  span.top {
    top: 4px;
    bottom: auto;
  }
  span.light {
    color: var(--evalW);
  }
</style>
