<script lang="ts">
  import { winPercent, type Score } from '$shared/accuracy';
  import { formatScore } from '$lib/format';

  // flip: White's part at the top (Black at the bottom of the board). horizontal: White's part from the left.
  type Props = { score: Score | null; dim?: boolean; flip?: boolean; horizontal?: boolean };
  const { score, dim = false, flip = false, horizontal = false }: Props = $props();

  const white = $derived(score ? winPercent(score) : 50);
  const label = $derived(score ? formatScore(score) : '');
</script>

<div
  class="bar"
  class:dim
  class:flip
  class:horizontal
  role="img"
  aria-label={score ? `Evaluation ${label} for White` : 'No evaluation'}
>
  <div class="white" style:--w="{white}%"></div>
  <span class:top={white < 50 !== flip} class:light={white < 50}>{label}</span>
</div>

<style>
  .bar {
    position: relative;
    display: flex;
    flex-direction: column-reverse;
    width: 24px;
    overflow: hidden;
    border-radius: 4px;
    background: var(--evalB);
  }
  .flip {
    flex-direction: column;
  }
  .dim {
    opacity: 0.45;
  }
  .white {
    height: var(--w);
    background: var(--evalW);
    transition: height 0.3s;
  }
  span {
    position: absolute;
    bottom: 4px;
    width: 100%;
    text-align: center;
    font: 600 10px var(--fontMono);
    color: var(--onLight);
  }
  span.top {
    top: 4px;
    bottom: auto;
  }
  span.light {
    color: var(--evalW);
  }
  .horizontal {
    flex-direction: row;
    width: 100%;
    height: 8px;
  }
  .horizontal .white {
    width: var(--w);
    height: auto;
    transition: width 0.3s;
  }
  .horizontal span {
    display: none;
  }
</style>
