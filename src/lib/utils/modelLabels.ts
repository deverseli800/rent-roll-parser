/**
 * Human-readable Claude model names, derived from the model ID so the label
 * can never drift from the model actually used (no hardcoded map to go
 * stale when the ladder in parsers/aiClient.ts changes).
 *
 *   claude-sonnet-5-5 -> Sonnet 5.5
 *   claude-opus-5-5   -> Opus 5.5
 *   claude-fable-5-1  -> Fable 5.1
 *
 * A trailing -YYYYMMDD snapshot suffix, if an id carries one, is dropped.
 *
 * Client-safe: no SDK imports, usable from React components.
 */
export function modelLabel(model: string): string {
  const stripped = model.replace(/^claude-/, '').replace(/-\d{8}$/, '');
  const [family, ...version] = stripped.split('-');
  if (!family) return model;
  const name = family.charAt(0).toUpperCase() + family.slice(1);
  return version.length > 0 ? `${name} ${version.join('.')}` : name;
}
