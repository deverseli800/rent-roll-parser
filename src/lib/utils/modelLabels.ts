/**
 * Human-readable Claude model names, derived from the model ID so the label
 * can never drift from the model actually used (no hardcoded map to go
 * stale when the ladder in parsers/aiClient.ts changes).
 *
 *   claude-sonnet-5            -> Sonnet 5
 *   claude-opus-4-8            -> Opus 4.8
 *   claude-fable-5             -> Fable 5
 *   claude-sonnet-4-5-20250929 -> Sonnet 4.5   (date snapshot suffix dropped)
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
