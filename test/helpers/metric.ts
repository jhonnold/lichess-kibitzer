import type { Metric } from 'prom-client';

/** The current value of a metric's sample (0 when it has none yet). Tests assert deltas: metrics are per process. */
export async function val(m: Metric, labels: Record<string, string> = {}, name = ''): Promise<number> {
  const { values } = await m.get();
  const hit = values.find(
    (v) =>
      (!name || v.metricName === name) &&
      Object.entries(labels).every(([k, x]) => v.labels[k] === x) &&
      Object.keys(v.labels).length === Object.keys(labels).length,
  );
  return hit?.value ?? 0;
}
