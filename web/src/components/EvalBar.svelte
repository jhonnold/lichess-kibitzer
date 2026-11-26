<script lang="ts">
  import { winPercent, type Score } from '$shared/accuracy';
  import { formatScore } from '$lib/format';

  type Props = { score: Score | null; dim?: boolean };
  const { score, dim = false }: Props = $props();

  const white = $derived(score ? winPercent(score) : 50);
  const label = $derived(score ? formatScore(score) : '');
</script>

<div class="bar" class:dim role="img" aria-label={score ? `Evaluation ${label} for White` : 'No evaluation'}>
  <div class="white" style:height="{white}%"></div>
  <span class:top={white < 50}>{label}</span>
</div>

<style>
  .bar {
    position: relative;
    display: flex;
    flex-direction: column-reverse;
    width: 40px;
    background: var(--evalB);
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
    color: var(--evalW);
  }
</style>
