/**
 * Deterministic bedroom/bathroom derivation.
 *
 * Bedrooms and bathrooms are crucial to residential rent rolls, so they are
 * promoted to first-class fields. The engine ALREADY captures the underlying
 * data on every path — either as dedicated columns in `sourceColumns`
 * ("Bedroom Count", "Baths", "BR"…) or embedded in `unitType` ("1BR/1BA",
 * "2/1.00", "Studio") — so the promotion is a pure, deterministic derivation
 * from that captured data rather than another field for the model to fill (which
 * is what produced inconsistent, sometimes-missing values). Running it at the
 * single `toGenericRentRollUnits` chokepoint gives every path — fast, AI, Excel,
 * PDF, CLI, eval — the same consistent answer.
 *
 * Non-destructive: it never mutates `sourceColumns`. The verbatim bed/bath
 * columns stay captured (the capture contract is untouched); the grid and export
 * simply suppress the now-redundant passthrough column in favour of the typed
 * field, using `isBedBathHeader`.
 */

function lettersOnly(header: string): string {
  return header.toLowerCase().replace(/[^a-z]/g, '');
}

/** A column header that denotes a bedroom count ("Bedroom Count", "Beds", "BR", "# of Bedrooms"). */
export function isBedroomHeader(header: string): boolean {
  const h = lettersOnly(header);
  if (!h) return false;
  if (h.includes('bedroom')) return true; // bedroom(s), bedroomcount, ofbedrooms…
  return ['bed', 'beds', 'br', 'bd', 'bdr', 'bdrm', 'bdrms', 'bedrm'].includes(h);
}

/** A column header that denotes a bathroom count ("Bathroom Count", "Baths", "BA"). */
export function isBathroomHeader(header: string): boolean {
  const h = lettersOnly(header);
  if (!h) return false;
  if (h.includes('bathroom')) return true; // bathroom(s), bathroomcount, ofbathrooms…
  return ['bath', 'baths', 'ba', 'bth', 'bthrm', 'bathrm'].includes(h);
}

/** True for a bed OR bath count header. "Room Count" (total rooms) is neither. */
export function isBedBathHeader(header: string): boolean {
  return isBedroomHeader(header) || isBathroomHeader(header);
}

/** Parse a count cell: numeric, or "Studio"/"Efficiency" -> 0. Negatives -> null. */
function parseCount(value: string | null | undefined): number | null {
  if (value == null) return null;
  const s = String(value).trim();
  if (!s) return null;
  if (/studio|efficiency|\beff\b|\befcy\b/i.test(s)) return 0;
  const m = s.match(/-?\d+(?:\.\d+)?/);
  if (!m) return null;
  const n = parseFloat(m[0]);
  return isNaN(n) || n < 0 ? null : n;
}

/** Pull bed/bath out of a combined unitType string ("1BR/1BA", "2/1.00", "Studio"). */
function parseUnitTypeBedBath(unitType: string): { bedrooms: number | null; bathrooms: number | null } {
  const s = unitType.toLowerCase();
  let bedrooms: number | null = null;
  let bathrooms: number | null = null;
  if (/\bstudio\b|efficiency/.test(s)) bedrooms = 0;
  const br = s.match(/(\d+(?:\.\d+)?)\s*(?:br|bed|bd)/);
  if (br) bedrooms = parseFloat(br[1]);
  const ba = s.match(/(\d+(?:\.\d+)?)\s*(?:ba|bath|bth)/);
  if (ba) bathrooms = parseFloat(ba[1]);
  // Slash form with no BR/BA tokens ("2/1", "2/1.00"): beds/baths.
  if (bedrooms === null && bathrooms === null) {
    const slash = s.match(/^\s*(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)/);
    if (slash) {
      bedrooms = parseFloat(slash[1]);
      bathrooms = parseFloat(slash[2]);
    }
  }
  return { bedrooms, bathrooms };
}

/**
 * Derive bedrooms/bathrooms for a unit. Dedicated `sourceColumns` win; a
 * combined `unitType` string fills whatever they leave null.
 */
export function deriveBedBath(
  sourceColumns: { header: string; value: string }[] | null | undefined,
  unitType: string | null | undefined
): { bedrooms: number | null; bathrooms: number | null } {
  let bedrooms: number | null = null;
  let bathrooms: number | null = null;
  for (const sc of sourceColumns ?? []) {
    if (!sc || !sc.header) continue;
    if (bedrooms === null && isBedroomHeader(sc.header)) {
      const v = parseCount(sc.value);
      if (v !== null) bedrooms = v;
    }
    if (bathrooms === null && isBathroomHeader(sc.header)) {
      const v = parseCount(sc.value);
      if (v !== null) bathrooms = v;
    }
  }
  if ((bedrooms === null || bathrooms === null) && unitType) {
    const p = parseUnitTypeBedBath(unitType);
    if (bedrooms === null) bedrooms = p.bedrooms;
    if (bathrooms === null) bathrooms = p.bathrooms;
  }
  return { bedrooms, bathrooms };
}
