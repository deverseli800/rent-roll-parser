/**
 * Scoring library for rent roll parser eval. See eval/SPEC.md.
 */
import type { GenericRentRollUnit } from '../src/lib/types';

export interface GroundTruthUnit {
  unitNumber: string;
  status: string;
  monthlyRent: number | null;
  acceptableRents?: (number | null)[];
  tenantName: string | null;
  unitSqft?: number | null;
  unitType?: string | null;
  leaseStartDate?: string | null;
  leaseEndDate?: string | null;
  moveInDate?: string | null;
  moveOutDate?: string | null;
  // Generic classification: 'residential' | 'commercial' | 'non_unit_income'.
  category?: string | null;
  // The rent-regulation / lease-type value printed for this unit in the
  // document, VERBATIM (e.g. "RS", "FM", "Decontrolled"). Graded by checking
  // the parser captured it in the unit's sourceColumns passthrough — the engine
  // is not expected to interpret it. null when the document has no such value.
  regulation?: string | null;
}

export interface GroundTruth {
  corpusId: string;
  documentFields: string[];
  statedUnitCount: number | null;
  statedTotalMonthlyRent: number | null;
  units: GroundTruthUnit[];
  verification?: { unitCountMatchesStated?: boolean | null; rentSumMatchesStated?: boolean | null; notes?: string };
  confidence: 'high' | 'medium' | 'low';
  notes?: string;
}

export interface CellResult {
  unitNumber: string;
  field: string;         // 'presence' | 'hallucinated' | field name
  expected: unknown;
  actual: unknown;
  correct: boolean;
}

export interface FileScore {
  corpusId: string;
  accuracy: number;
  totalCells: number;
  correctCells: number;
  gtUnits: number;
  extractedUnits: number;
  matchedUnits: number;
  missedUnits: string[];
  hallucinatedUnits: string[];
  fieldBreakdown: Record<string, { correct: number; total: number }>;
  errors: CellResult[];   // incorrect cells only
}

const PLACEHOLDER_NAMES = new Set([
  'vacant', 'vacant vacant', 'available', 'empty', 'model', 'n/a', 'na', '-', '--',
]);

/** Normalize a unit number for matching */
export function normalizeUnitNumber(raw: string): string {
  let s = String(raw).toUpperCase().trim();
  s = s.replace(/^(UNIT|APT|APARTMENT)\s*[#:.]?\s*/i, '');
  s = s.replace(/[#\s.,_/\\-]+/g, '');
  // strip leading zeros in digit runs: "01E" -> "1E", "003" -> "3"
  s = s.replace(/\d+/g, d => String(parseInt(d, 10)));
  return s;
}

export function normalizeName(raw: string | null): string | null {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!s || PLACEHOLDER_NAMES.has(s)) return null;
  return s;
}

function tokenSet(s: string): Set<string> {
  return new Set(s.split(' ').filter(Boolean));
}

function setsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = cur;
  }
  return prev[n];
}

function nameSimilarity(a: string, b: string): number {
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  return 1 - levenshtein(a, b) / maxLen;
}

export function namesMatch(gt: string | null, actual: string | null): boolean {
  const g = normalizeName(gt);
  const a = normalizeName(actual);
  if (g === null && a === null) return true;
  if (g === null || a === null) return false;
  if (g === a) return true;
  if (setsEqual(tokenSet(g), tokenSet(a))) return true;
  if (nameSimilarity(g, a) >= 0.85) return true;
  // sorted-token comparison handles reordering with slight spelling variance
  const gSorted = [...tokenSet(g)].sort().join(' ');
  const aSorted = [...tokenSet(a)].sort().join(' ');
  return nameSimilarity(gSorted, aSorted) >= 0.85;
}

function numbersMatch(gt: number | null, actual: number | null, acceptable?: (number | null)[]): boolean {
  const candidates: (number | null)[] = [gt, ...(acceptable ?? [])];
  for (const c of candidates) {
    if (c === null && actual === null) return true;
    if (c === null || actual === null) continue;
    const tol = Math.max(1, Math.abs(c) * 0.005);
    if (Math.abs(c - actual) <= tol) return true;
  }
  return false;
}

function statusMatch(gt: string, actual: string): boolean {
  if (gt === actual) return true;
  // applicant/vacant boundary is genuinely ambiguous
  const pair = new Set([gt, actual]);
  if (pair.has('applicant') && pair.has('vacant')) return true;
  return false;
}

/** Parse "4/1", "4BR/1BA", "4 bed / 1 bath", "Studio/1BA" into a bed/bath tuple */
function bedBathTuple(s: string): string | null {
  const t = s.toLowerCase().replace(/\s+/g, '');
  const m = t.match(/^(\d+|studio)(?:br|bed(?:room)?s?)?[/-]([\d.]+|-+)(?:ba|bath(?:room)?s?)?$/);
  if (!m) return null;
  const beds = m[1] === 'studio' ? '0' : String(parseFloat(m[1]));
  const baths = /^-+$/.test(m[2]) ? '?' : String(parseFloat(m[2]));
  return `${beds}/${baths}`;
}

function typesMatch(gt: string | null, actual: string | null): boolean {
  // Placeholder-only strings ("--/--") normalize to '' and are null-equivalent
  const norm = (s: string | null) => s === null ? '' : s.toLowerCase().replace(/[^a-z0-9]+/g, '');
  const g = norm(gt), a = norm(actual);
  if (!g && !a) return true;
  if (!g || !a) return false;
  if (g === a || g.includes(a) || a.includes(g)) return true;
  // Semantically equal bed/bath notations ("4/1" == "4BR/1BA")
  const gt_ = bedBathTuple(gt!), at_ = bedBathTuple(actual!);
  return gt_ !== null && at_ !== null && gt_ === at_;
}

function datesMatch(gt: string | null, actual: string | null): boolean {
  if (gt === null && actual === null) return true;
  if (gt === null || actual === null) return false;
  return gt.slice(0, 10) === actual.slice(0, 10);
}

function categoryMatch(gt: string | null | undefined, actual: string | null | undefined): boolean {
  const norm = (s: string | null | undefined) => (s === null || s === undefined) ? null : String(s).toLowerCase().trim();
  const g = norm(gt), a = norm(actual);
  if (g === null && a === null) return true;
  if (g === null || a === null) return false;
  return g === a;
}

const normReg = (s: string) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '');
/**
 * True if the expected verbatim regulation label was captured in the unit's
 * sourceColumns passthrough. Tests CAPTURE, not interpretation: the engine must
 * preserve the document's regulation/lease-type cell somewhere, not decode it.
 * A null/blank expected value is trivially satisfied (nothing to capture).
 */
function regulationCaptured(expected: string | null | undefined, sourceColumns?: { header: string; value: string }[]): boolean {
  if (expected === null || expected === undefined || String(expected).trim() === '') return true;
  const want = normReg(expected);
  if (!want) return true;
  if (!sourceColumns || sourceColumns.length === 0) return false;
  return sourceColumns.some(c => {
    const v = normReg(c.value);
    if (!v) return false;
    if (v === want) return true;
    return want.length >= 2 && (v.includes(want) || want.includes(v));
  });
}

/**
 * Align extracted units to ground truth units by normalized unit number.
 * Handles multi-property files where one side may carry a building prefix:
 * falls back to suffix matching when exact normalized match fails and the
 * match is unambiguous.
 */
function alignUnits(gtUnits: GroundTruthUnit[], extracted: GenericRentRollUnit[]): Map<number, number> {
  const mapping = new Map<number, number>(); // gt index -> extracted index
  const usedExtracted = new Set<number>();

  const gtNorm = gtUnits.map(u => normalizeUnitNumber(u.unitNumber));
  const exNorm = extracted.map(u => normalizeUnitNumber(u.unitNumber));

  // Pass 1: exact normalized match (first unused occurrence)
  for (let i = 0; i < gtUnits.length; i++) {
    for (let j = 0; j < extracted.length; j++) {
      if (usedExtracted.has(j)) continue;
      if (gtNorm[i] === exNorm[j] && gtNorm[i] !== '') {
        mapping.set(i, j);
        usedExtracted.add(j);
        break;
      }
    }
  }

  // Pass 2: unambiguous suffix/prefix match (building-prefixed unit numbers)
  for (let i = 0; i < gtUnits.length; i++) {
    if (mapping.has(i)) continue;
    const g = gtNorm[i];
    if (!g) continue;
    const candidates: number[] = [];
    for (let j = 0; j < extracted.length; j++) {
      if (usedExtracted.has(j)) continue;
      const e = exNorm[j];
      if (!e) continue;
      if ((e.endsWith(g) || g.endsWith(e)) && Math.min(g.length, e.length) >= 2) {
        candidates.push(j);
      }
    }
    if (candidates.length === 1) {
      // Also require the shorter one to be a meaningful fraction of the longer
      const j = candidates[0];
      mapping.set(i, j);
      usedExtracted.add(j);
    }
  }

  return mapping;
}

const FIELD_ORDER = [
  'status', 'monthlyRent', 'tenantName', 'unitSqft', 'unitType',
  'leaseStartDate', 'leaseEndDate', 'moveInDate', 'moveOutDate',
  'category', 'regulation',
] as const;

export function scoreFile(gt: GroundTruth, extracted: GenericRentRollUnit[]): FileScore {
  const fields = FIELD_ORDER.filter(f => gt.documentFields.includes(f));
  const mapping = alignUnits(gt.units, extracted);
  const matchedExtracted = new Set(mapping.values());

  const cells: CellResult[] = [];
  const fieldBreakdown: Record<string, { correct: number; total: number }> = {
    presence: { correct: 0, total: 0 },
    hallucinated: { correct: 0, total: 0 },
  };
  for (const f of fields) fieldBreakdown[f] = { correct: 0, total: 0 };

  const missedUnits: string[] = [];
  const hallucinatedUnits: string[] = [];

  for (let i = 0; i < gt.units.length; i++) {
    const g = gt.units[i];
    const j = mapping.get(i);
    const found = j !== undefined;
    fieldBreakdown.presence.total++;
    cells.push({ unitNumber: g.unitNumber, field: 'presence', expected: 'found', actual: found ? 'found' : 'MISSING', correct: found });
    if (!found) {
      missedUnits.push(g.unitNumber);
      // all graded fields count as wrong
      for (const f of fields) {
        fieldBreakdown[f].total++;
        cells.push({ unitNumber: g.unitNumber, field: f, expected: (g as unknown as Record<string, unknown>)[f] ?? null, actual: '(unit missing)', correct: false });
      }
      continue;
    }
    fieldBreakdown.presence.correct++;
    const e = extracted[j!];

    for (const f of fields) {
      let ok = false;
      const expected = (g as unknown as Record<string, unknown>)[f] ?? null;
      let actual: unknown = (e as unknown as Record<string, unknown>)[f] ?? null;
      switch (f) {
        case 'status':
          ok = statusMatch(g.status, e.status);
          actual = e.status;
          break;
        case 'monthlyRent': {
          ok = numbersMatch(g.monthlyRent, e.monthlyRent, g.acceptableRents);
          // 0 and null are both defensible readings of a blank/zero rent cell
          if (!ok) {
            const zeroish = (v: number | null) => v === null || v === 0;
            ok = zeroish(g.monthlyRent) && zeroish(e.monthlyRent);
          }
          break;
        }
        case 'unitSqft': {
          const gv = (g.unitSqft ?? null) as number | null;
          ok = numbersMatch(gv, e.unitSqft);
          // A printed sqft of 0 means "no data" — 0 and null are equivalent
          if (!ok) {
            const zeroish = (v: number | null) => v === null || v === 0;
            ok = zeroish(gv) && zeroish(e.unitSqft);
          }
          break;
        }
        case 'tenantName':
          ok = namesMatch(g.tenantName, e.tenantName);
          break;
        case 'unitType':
          ok = typesMatch((g.unitType ?? null) as string | null, e.unitType);
          break;
        case 'leaseStartDate': ok = datesMatch((g.leaseStartDate ?? null) as string | null, e.leaseStartDate); break;
        case 'leaseEndDate': ok = datesMatch((g.leaseEndDate ?? null) as string | null, e.leaseEndDate); break;
        case 'moveInDate': ok = datesMatch((g.moveInDate ?? null) as string | null, e.moveInDate); break;
        case 'moveOutDate': ok = datesMatch((g.moveOutDate ?? null) as string | null, e.moveOutDate); break;
        case 'category':
          ok = categoryMatch(g.category, e.category);
          actual = e.category ?? null;
          break;
        case 'regulation':
          ok = regulationCaptured(g.regulation, e.sourceColumns);
          actual = e.sourceColumns ?? null;
          break;
      }
      fieldBreakdown[f].total++;
      if (ok) fieldBreakdown[f].correct++;
      cells.push({ unitNumber: g.unitNumber, field: f, expected, actual, correct: ok });
    }
  }

  // hallucinated units
  for (let j = 0; j < extracted.length; j++) {
    if (matchedExtracted.has(j)) continue;
    hallucinatedUnits.push(extracted[j].unitNumber);
    fieldBreakdown.hallucinated.total++;
    cells.push({ unitNumber: extracted[j].unitNumber, field: 'hallucinated', expected: '(not a unit)', actual: 'extracted', correct: false });
  }

  const totalCells = cells.length;
  const correctCells = cells.filter(c => c.correct).length;

  return {
    corpusId: gt.corpusId,
    accuracy: totalCells === 0 ? 1 : correctCells / totalCells,
    totalCells,
    correctCells,
    gtUnits: gt.units.length,
    extractedUnits: extracted.length,
    matchedUnits: mapping.size,
    missedUnits,
    hallucinatedUnits,
    fieldBreakdown,
    errors: cells.filter(c => !c.correct),
  };
}
