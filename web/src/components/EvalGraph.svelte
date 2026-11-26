<script lang="ts">
  import { CategoryScale, Chart, Filler, LinearScale, LineController, LineElement, PointElement } from 'chart.js';
  import type { Score } from '$shared/accuracy';
  import type { Ply } from '$shared/types';
  import { evalSeries } from '$shared/viewer';

  Chart.register(LineController, LineElement, PointElement, LinearScale, CategoryScale, Filler);

  type Props = { plies: Ply[]; live: Score | null };
  const { plies, live }: Props = $props();

  let canvas: HTMLCanvasElement;
  let chart: Chart<'line', (number | null)[], number> | undefined;
  let series = evalSeries([], null); // read by the chart's style callbacks; not reactive

  // White win % over plies; Provisional segments dashed and muted; a dot on the latest point.
  $effect(() => {
    const css = (token: string) => getComputedStyle(canvas).getPropertyValue(token).trim();
    const muted = css('--muted');
    const provisional = (i: number) => series.provisional[i];
    chart = new Chart(canvas, {
      type: 'line',
      data: { labels: [], datasets: [{ data: [] }] },
      options: {
        animation: false,
        maintainAspectRatio: false,
        events: [],
        scales: { x: { display: false }, y: { display: false, min: 0, max: 100 } },
        datasets: {
          line: {
            borderWidth: 2,
            borderColor: css('--accent'),
            fill: { target: { value: 50 }, above: css('--graphW'), below: 'transparent' },
            segment: {
              borderColor: (c) => (provisional(c.p0DataIndex) || provisional(c.p1DataIndex) ? muted : undefined),
              borderDash: (c) => (provisional(c.p0DataIndex) || provisional(c.p1DataIndex) ? [4, 4] : undefined),
            },
            pointRadius: (c) => (c.dataIndex === series.win.findLastIndex((w) => w !== null) ? 4 : 0),
            pointBackgroundColor: css('--accent'),
          },
        },
      },
    });
    return () => chart?.destroy();
  });
  $effect(() => {
    series = evalSeries(plies, live);
    if (!chart) return;
    chart.data.labels = series.win.map((_, i) => i);
    chart.data.datasets[0].data = series.win;
    chart.update();
  });
</script>

<div class="graph"><canvas bind:this={canvas}></canvas></div>

<style>
  .graph {
    position: relative;
    height: 120px;
    border-top: 1px solid var(--line);
    border-bottom: 1px solid var(--line);
  }
</style>
