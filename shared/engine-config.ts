import type { EngineConfig, EngineCopy, EngineRole } from './types.js';

/** UCI options each copy sets from its own settings, never from the shared EngineConfig.options. */
export const COPY_OPTIONS: readonly string[] = ['Threads', 'Hash', 'MultiPV'];
export const DEFAULT_COPY: EngineCopy = { threads: 1, hash: 1024 };
export const DEFAULT_MULTI_PV = 5;
export const MAX_MULTI_PV = 256;

/** A config with default copies (MultiPV `multiPv` for multi). */
export const engineConfig = (
  path: string,
  options: Record<string, string> = {},
  multiPv = DEFAULT_MULTI_PV,
): EngineConfig => ({
  path,
  options,
  main: { ...DEFAULT_COPY },
  multi: { ...DEFAULT_COPY, multiPv },
});

const int = (s: string | undefined, min: number, fallback: number): number => {
  const n = Number(s);
  return Number.isInteger(n) && n >= min ? n : fallback;
};

/** A config saved before per-copy settings ({ path, options }, Threads/Hash/MultiPV among the options): those keys move
 *  into both copies (MultiPV only into multi, and only when 2 or more). A current config is returned as is. */
export function migrateEngine(cfg: EngineConfig | { path: string; options: Record<string, string> }): EngineConfig {
  if ('main' in cfg && 'multi' in cfg) return cfg;
  const { Threads, Hash, MultiPV, ...options } = cfg.options;
  const copy = { threads: int(Threads, 1, DEFAULT_COPY.threads), hash: int(Hash, 1, DEFAULT_COPY.hash) };
  return { path: cfg.path, options, main: copy, multi: { ...copy, multiPv: int(MultiPV, 2, DEFAULT_MULTI_PV) } };
}

/** What one copy sends after `uci`, in order: the shared options, then its Threads and Hash, then MultiPV last (1 for
 *  main), so a shared option can never change it. */
export function copyOptions(cfg: EngineConfig, role: EngineRole): [string, string][] {
  const own = role === 'main' ? { ...cfg.main, multiPv: 1 } : cfg.multi;
  return [
    ...Object.entries(cfg.options).filter(([k]) => !COPY_OPTIONS.includes(k)),
    ['Threads', String(own.threads)],
    ['Hash', String(own.hash)],
    ['MultiPV', String(own.multiPv)],
  ];
}
