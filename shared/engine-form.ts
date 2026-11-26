import type { UciOption } from '../src/engine/uci-parser.js';

export type { UciOption };

/**
 * Admin form start values, as UCI strings: the engine's own defaults, overlaid with the current config (the saved
 * one, else the server default). Buttons have no value; config keys the engine lacks are dropped.
 */
export function initialValues(options: UciOption[], config: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    options.filter((o) => o.type !== 'button').map((o) => [o.name, config[o.name] ?? o.default ?? '']),
  );
}

/** Config to save: only values that differ from the engine's default (so empty strings are never sent). */
export function changedOptions(options: UciOption[], values: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    options
      .filter((o) => o.type !== 'button' && o.name in values && values[o.name] !== (o.default ?? ''))
      .map((o) => [o.name, values[o.name]]),
  );
}
