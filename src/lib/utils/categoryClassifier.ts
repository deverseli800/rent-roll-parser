import { extractStructured, MODELS, type AIUsage } from '../parsers/aiClient';
import type { GenericRentRollUnit } from '../types';

/**
 * Per-document review of what each row IS (residential / commercial /
 * ancillary income line).
 *
 * WHY THIS EXISTS SEPARATELY FROM THE PARSERS
 *
 * The two extraction paths answer this question with very different equipment.
 * The full-AI path classifies every row from the document's own use labels and
 * is good at it. The fast path cannot: it deliberately buys determinism by not
 * sending rows to a model, so `classifyCategory` in excelFastPath.ts is a
 * keyword prior over the unit id and unit-type text. That prior has no way to
 * read a convention like a blank bed/bath field, and a wrong label there is
 * unrecoverable downstream — it has already moved `includeInUnitCount` and
 * through it the residential unit count consumers read first.
 *
 * So this runs on BOTH paths, after extraction, from the walked/extracted rows
 * rather than any sampled preview of the sheet. That matters: the fast-path
 * mapper only sees `sampleGrid`'s window (first 50 + 16 middle + last 60 lines),
 * and on a 407-line corpus file all 16 of its lettered units sat at lines
 * 255-270 — zero of them visible. The extracted rows are the only view of a
 * document that is never sample-limited.
 *
 * The unit of work is the distinct ROW SHAPE, not the row: a 392-unit export
 * collapses to a handful of (prior, unit-id prefix, unit-type value) groups, so
 * this is one small call regardless of roll size — and no call at all for the
 * common case where nothing looks ambiguous.
 *
 * WHAT IT MAY REASON FROM
 *
 * The rows themselves, verbatim — the candidate rows and a sample of the
 * document's other rows, every captured column included — and the model's own
 * judgment of them. It is NOT handed pre-digested conclusions or examples of
 * what a placeholder looks like: recognising that a bed/bath cell carries no
 * real count, by comparing it with the rows that do, is the judgment being
 * asked for, and a prompt that names the pattern turns it into a lookup.
 *
 * A move needs a structural ground from the document: a use label, a unit id
 * that spells out its use, or a space-describing field (bed/bath, unit type)
 * that marks the row as unlike the document's dwellings. The tenant name may
 * corroborate that ground — a business entity in a row whose bed/bath field is
 * empty is two signals agreeing — but never stands alone, because a corporate
 * lessee of an apartment is ordinary. Rent size is not a ground. The model
 * reports its grounds and `gateCategoryProposal` enforces both rules.
 */

export type UnitCategory = 'residential' | 'commercial' | 'non_unit_income';

const CATEGORIES: readonly UnitCategory[] = ['residential', 'commercial', 'non_unit_income'];

/**
 * Grounds the model is asked to report for each proposal. The gate, not the
 * prompt, is what makes the restriction real.
 */
const EVIDENCE_KINDS = [
  'explicit_use_label',        // a column or value says commercial/store/retail/office/...
  'unit_label',                // the unit id itself names it (STORE, RETAIL-1, COMM2)
  'no_bed_bath',               // bed/bath or unit-type left non-applicable where dwellings carry one
  'dwelling_markers',          // bed/bath count or floorplan code present -> it IS a dwelling
  'ancillary_label',           // parking/garage/laundry/storage/antenna/signage
  'tenant_name',               // the tenant is consistent with the use -> corroborates, never sufficient alone
  'unsure',                    // the rows don't settle it -> keep the parser's label
] as const;

type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

/** Headers whose value answers "is this a dwelling", when the mapper did not promote it to unitType. */
const USE_COLUMN = /bd\s*\/?\s*ba|bed|bath|unit\s*type|floor\s*plan|floorplan|\btype\b|\buse\b|occupancy/i;

/**
 * True when a unit-type value carries no dwelling information: absent, blank,
 * or a not-applicable placeholder. "--/--" and "-/-" are how several exports
 * print a bed/bath cell for space that has neither, which is exactly the signal
 * the keyword prior cannot see. "3/--" (3 beds, baths not stated) and an opaque
 * per-property floorplan code (e.g. "PLAN-1B1") do carry it.
 */
function isBlankish(text: string | null | undefined): boolean {
  if (text === null || text === undefined) return true;
  const s = text.trim();
  if (!s) return true;
  if (/^(n\/?a|none|null|tbd|unknown)$/i.test(s)) return true;
  return !/[0-9a-z]/i.test(s.replace(/[-–—_/.\s]/g, ''));
}

/** The unit-type text for a row, from the mapped field or the captured column the mapper skipped. */
function typeTextOf(unit: GenericRentRollUnit): { text: string | null; header: string | null } {
  if (unit.unitType !== null && unit.unitType !== undefined && String(unit.unitType).trim()) {
    return { text: String(unit.unitType).trim(), header: 'unitType' };
  }
  for (const col of unit.sourceColumns ?? []) {
    if (col?.header && USE_COLUMN.test(col.header)) {
      return { text: col.value === null || col.value === undefined ? null : String(col.value).trim(), header: col.header };
    }
  }
  return { text: null, header: null };
}

/** Leading alphabetic run of a unit id ("C1" -> "C", "STORE" -> "STORE", "0412" -> ""). */
function labelPrefix(unitNumber: string): string {
  return (unitNumber.match(/^[A-Za-z]+/)?.[0] ?? '').toUpperCase();
}

export interface CategoryCandidate {
  key: string;
  prior: UnitCategory;
  count: number;
  unitNumbers: string[];
  typeHeader: string | null;
  typeText: string | null;
  /** Why this shape was put up for review, for the prompt and for logging. */
  reason: string;
}

export interface CandidateReport {
  candidates: CategoryCandidate[];
  totalUnits: number;
}

/**
 * Group rows into distinct shapes and return only the shapes worth a model's
 * attention, plus the document's own dwelling vocabulary for contrast.
 *
 * Two things get reviewed:
 *
 *  1. Anything the prior called commercial or non_unit_income. A false
 *     commercial label is the expensive direction (it corrupts the residential
 *     count before any consumer can correct it), so the labels we assert are
 *     checked, not just the ones we default on.
 *
 *  2. Rows the prior defaulted to residential that carry NO dwelling marker in
 *     a document whose other rows do. This is the case a keyword prior is blind
 *     to and the one that motivated the module: a 6-unit sheet printing "3/--"
 *     for its apartments and "--/--" for its three stores.
 *
 * Deliberately NOT reviewed: a residential row that looks like its neighbours.
 * On a 392-unit file whose lettered units carry the same floorplan code as
 * everything else, there is nothing to ask about — which is why that file costs
 * zero extra calls.
 */
export function collectCategoryCandidates(units: GenericRentRollUnit[]): CandidateReport {
  const rows = units.map(u => {
    const { text, header } = typeTextOf(u);
    return {
      unit: u,
      prior: (u.category ?? 'residential') as UnitCategory,
      typeText: text,
      typeHeader: header,
      blank: isBlankish(text),
    };
  });
  const total = rows.length;
  const typedUnits = rows.filter(r => !r.blank).length;

  const groups = new Map<string, CategoryCandidate & { blank: boolean }>();
  for (const r of rows) {
    const key = `${r.prior}|${labelPrefix(r.unit.unitNumber)}|${r.blank ? '(blank)' : r.typeText}`;
    const g = groups.get(key) ?? {
      key,
      prior: r.prior,
      count: 0,
      unitNumbers: [],
      typeHeader: r.typeHeader,
      typeText: r.blank ? null : r.typeText,
      reason: '',
      blank: r.blank,
    };
    g.count++;
    if (g.unitNumbers.length < 6) g.unitNumbers.push(r.unit.unitNumber);
    groups.set(key, g);
  }

  // A document that states no unit types anywhere offers nothing to contrast
  // against, so a missing marker means nothing there. Requiring both an
  // absolute floor and a share keeps this from firing on a stray typed row.
  const contrastAvailable = typedUnits >= 3 && typedUnits / total >= 0.25;

  const candidates: CategoryCandidate[] = [];
  for (const g of groups.values()) {
    if (g.prior === 'commercial') {
      g.reason = `the parser labelled ${g.count} row${g.count === 1 ? '' : 's'} "commercial" — confirm or correct it`;
      candidates.push(g);
      continue;
    }
    // non_unit_income priors are deliberately NOT reviewed. That label only
    // comes from the document naming the thing ("Parking", "Laundry",
    // "Storage") — a positive signal, unlike a commercial label, which the
    // prior will also assert from a bare unit-id convention. Reviewing them
    // would put a call on nearly every roll (most carry a parking line) to
    // second-guess the document's own word. Revisit if ancillary-vs-commercial
    // ever turns out to matter to a consumer.
    if (g.prior !== 'residential') continue;
    // `typedUnits >= g.count` states the contrast the right way round: more rows
    // carry a marker than this group lacks one. A fraction-of-document test gets
    // this wrong on small sheets — the 6-unit file that motivated the module is
    // exactly 3 stores to 3 apartments, and "under half the document" excluded
    // the very rows it was written for.
    if (g.blank && contrastAvailable && typedUnits >= g.count) {
      // Say why the shape was flagged, not what to conclude: the model judges
      // the rows themselves, shown verbatim alongside the document's others.
      g.reason = `the parser defaulted to residential; its ${g.typeHeader ?? 'unit type'} field differs from the document's other rows`;
      candidates.push(g);
    }
  }
  return { candidates, totalUnits: total };
}

/**
 * Grounds that can support a conclusion on their own, by conclusion.
 *
 * The asymmetry is the point, and it follows the same logic as the `^C\d`
 * deletion in excelFastPath.ts: calling something a dwelling is the safe
 * default (a consumer with better information promotes it later), while
 * asserting commercial corrupts a count nobody re-derives. So concluding
 * residential requires positive dwelling markers, not merely the absence of a
 * commercial signal.
 *
 * `tenant_name` appears in no set: it may accompany a ground but never be one.
 */
const SUPPORTS: Record<UnitCategory, ReadonlySet<EvidenceKind>> = {
  residential: new Set<EvidenceKind>(['dwelling_markers']),
  commercial: new Set<EvidenceKind>(['explicit_use_label', 'unit_label', 'no_bed_bath']),
  non_unit_income: new Set<EvidenceKind>(['ancillary_label', 'explicit_use_label', 'unit_label']),
};

/** Grounds that may be cited alongside any conclusion without arguing against it. */
const CORROBORATING: ReadonlySet<EvidenceKind> = new Set<EvidenceKind>(['tenant_name']);

/**
 * Whether an answer is internally consistent — its grounds actually argue for
 * its conclusion.
 *
 * This is a real observed failure, not a theoretical one: on the 6-unit sheet
 * that motivated this module, 1 of 8 review calls came back
 * `{category: residential, evidence: no_bed_bath}` — citing a non-applicable
 * bed/bath field, which is evidence AGAINST a dwelling, in support of calling it
 * a dwelling. The gate below could not catch it, because the incoherent answer
 * happened to match the parser's existing label and so read as agreement.
 * Treating it as unusable (and letting the retry ask again) is what makes the
 * review stable; scoring it as a vote would have silently kept a wrong label.
 *
 * Coherent means: "unsure" alone (the model is told to return the parser's
 * label then), or at least one ground that supports the conclusion and none
 * that supports a different one. Corroboration is neutral.
 */
export function isCoherentAnswer(category: UnitCategory, evidence: readonly EvidenceKind[]): boolean {
  if (evidence.length === 0) return false;
  if (evidence.every(e => e === 'unsure')) return true;
  const grounds = evidence.filter(e => e !== 'unsure' && !CORROBORATING.has(e));
  return grounds.length > 0 && grounds.every(e => SUPPORTS[category].has(e));
}

/**
 * Whether the model's proposal for a row shape is allowed to stand.
 *
 *   accept  — take the model's category
 *   decline — keep the parser's, record the disagreement
 *   noop    — they agree
 *
 * Every accepted proposal must name a structural ground that supports it. A
 * proposal resting on the tenant name alone, or on nothing, is declined — that
 * is where the rule is enforced, rather than trusting the prompt to have been
 * obeyed.
 */
export function gateCategoryProposal(
  from: UnitCategory,
  to: UnitCategory,
  evidence: readonly EvidenceKind[]
): 'accept' | 'decline' | 'noop' {
  if (from === to) return 'noop';
  return evidence.some(e => SUPPORTS[to].has(e)) ? 'accept' : 'decline';
}

const REVIEW_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['groups'],
  properties: {
    groups: {
      type: 'array',
      description: 'One entry per row shape given, using the key string verbatim.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['key', 'category', 'evidence'],
        properties: {
          key: { type: 'string', description: 'The shape key, copied verbatim from the input list' },
          category: { type: 'string', enum: [...CATEGORIES] },
          evidence: {
            type: 'array',
            description: 'Every ground you relied on',
            items: { type: 'string', enum: [...EVIDENCE_KINDS] },
          },
        },
      },
    },
  },
};

const PROMPT = `You are reviewing what certain rows of ONE multifamily rent roll ARE, so downstream code counts dwellings correctly. A deterministic parser already labelled every row. Below are the row shapes whose label is worth a second look, each with its rows exactly as the document prints them, followed by a sample of the document's other rows for comparison.

Assign each shape exactly one category:
  residential      a dwelling: apartment, condo, house, including superintendent/employee units and rent-regulated apartments.
  commercial       non-dwelling leasable space: store, retail, office, professional, restaurant, medical.
  non_unit_income  an ancillary income line that is neither: parking space/garage, antenna/cell tower, laundry, storage rented as income, signage/billboard.

Report every ground you relied on:
  explicit_use_label  a use/type column or value states the use
  unit_label          the unit id itself spells out the use
  no_bed_bath         the row's bed/bath or unit-type field carries no real dwelling description, where the document's dwellings do carry one
  dwelling_markers    the row has a real bedroom/bathroom count or floorplan, so it is a dwelling
  ancillary_label     the row names parking, a garage, laundry, storage, an antenna or signage
  tenant_name         the tenant is consistent with your answer (supporting only)
  unsure              the rows don't settle it

Judge from how the document describes the space, comparing each shape with the document's other rows. The tenant can support what those columns show, but it cannot decide on its own — businesses lease apartments too. Rent size is not evidence. If the rows don't settle it, keep the parser's label and answer unsure.

Return one entry per shape, with the key copied verbatim.`;

/** Candidate rows shown per shape, and other rows shown for comparison. */
const ROWS_PER_SHAPE = 4;
const OTHER_ROWS = 8;

/** A row's shape key — the same grouping collectCategoryCandidates uses. */
function shapeKeyOf(u: GenericRentRollUnit): string {
  const { text } = typeTextOf(u);
  const prior = (u.category ?? 'residential') as UnitCategory;
  return `${prior}|${labelPrefix(u.unitNumber)}|${isBlankish(text) ? '(blank)' : text}`;
}

/** One row as the document prints it: unit id, then every captured column. */
function renderRow(u: GenericRentRollUnit): string {
  const cols = (u.sourceColumns ?? [])
    .filter(c => c?.header && c.value !== null && c.value !== undefined && String(c.value).trim())
    .slice(0, 24)
    .map(c => `${c.header}: ${String(c.value).trim().slice(0, 60)}`);
  // Extraction paths that capture no source columns, or that promoted the
  // tenant column out of them: the tenant is part of what the model weighs.
  if (u.tenantName && !(u.sourceColumns ?? []).some(c => String(c?.value ?? '').trim() === u.tenantName!.trim())) {
    cols.push(`tenant: ${u.tenantName}`);
  }
  if (cols.length === 0 && u.unitType) cols.push(`unit type: ${u.unitType}`);
  return `${u.unitNumber} | ${cols.join(' | ')}`;
}

/** Up to `n` items evenly spaced through `items`, so the sample spans the document. */
function spread<T>(items: T[], n: number): T[] {
  if (items.length <= n) return items;
  return Array.from({ length: n }, (_, i) => items[Math.floor((i * items.length) / n)]);
}

/**
 * Review and correct row categories from a model-built read of this document's
 * own conventions. Mutates `units` in place.
 *
 * Fails open in every direction — the parser's labels stand when there is
 * nothing to review, when the call errors, and for any shape the model omits,
 * mislabels, or cannot ground in document evidence.
 */
export async function reviewUnitCategories(
  units: GenericRentRollUnit[],
  usages: AIUsage[]
): Promise<{
  reviewed: number;
  changed: { units: string[]; from: UnitCategory; to: UnitCategory; evidence: EvidenceKind[] }[];
  declined: { units: string[]; kept: UnitCategory; proposed: UnitCategory; evidence: EvidenceKind[] }[];
}> {
  const { candidates, totalUnits } = collectCategoryCandidates(units);
  if (candidates.length === 0) return { reviewed: 0, changed: [], declined: [] };

  const byShape = new Map<string, GenericRentRollUnit[]>();
  const others: GenericRentRollUnit[] = [];
  const candidateKeys = new Set(candidates.map(c => c.key));
  for (const u of units) {
    const key = shapeKeyOf(u);
    if (candidateKeys.has(key)) byShape.set(key, [...(byShape.get(key) ?? []), u]);
    else others.push(u);
  }
  const listing = candidates
    .map(c => {
      const rows = (byShape.get(c.key) ?? []).slice(0, ROWS_PER_SHAPE).map(u => `    ${renderRow(u)}`).join('\n');
      return `- key "${c.key}" — ${c.count} row${c.count === 1 ? '' : 's'}; parser's label: ${c.prior} (${c.reason})\n${rows}`;
    })
    .join('\n');
  const sample = spread(others, OTHER_ROWS).map(u => `    ${renderRow(u)}`).join('\n');
  const comparison = sample
    ? `\n\nTHE DOCUMENT'S OTHER ROWS (${others.length}${others.length > OTHER_ROWS ? `, ${OTHER_ROWS} shown` : ''}):\n${sample}`
    : '';

  const validCategory = new Set<string>(CATEGORIES);
  const validEvidence = new Set<string>(EVIDENCE_KINDS);
  let assigned = new Map<string, { category: UnitCategory; evidence: EvidenceKind[] }>();
  // One retry, matching classifyChargeCodes: the observed failures are
  // transient server-side 400s and the call is small enough to repeat.
  for (let attempt = 1; attempt <= 2 && assigned.size === 0; attempt++) {
    try {
      const { data, usage } = await extractStructured<{ groups: { key: string; category: string; evidence: string[] }[] }>({
        model: MODELS.fast,
        content: [{
          type: 'text',
          text: `${PROMPT}\n\nROW SHAPES TO REVIEW (${candidates.length}, out of ${totalUnits} rows in the document):\n${listing}${comparison}`,
        }],
        schema: REVIEW_SCHEMA,
        maxTokens: 8000,
      });
      usages.push(usage);
      if (process.env.CATEGORY_DEBUG) console.warn('[categoryClassifier] raw:', JSON.stringify(data.groups));
      assigned = new Map(
        (data.groups ?? [])
          .filter(g => g?.key && validCategory.has(g.category) && Array.isArray(g.evidence))
          .map(g => ({
            key: g.key,
            category: g.category as UnitCategory,
            evidence: [...new Set(g.evidence.filter(e => validEvidence.has(e)))] as EvidenceKind[],
          }))
          // Drop answers whose grounds contradict their conclusion. When that
          // leaves nothing usable the retry above asks again, which is the whole
          // reason a self-contradictory answer is worth detecting.
          .filter(g => isCoherentAnswer(g.category, g.evidence))
          .map(g => [g.key, { category: g.category, evidence: g.evidence }])
      );
    } catch (e) {
      // A failed review must never fail the extraction: the parser's labels are
      // already in place and remain valid.
      console.warn(
        `[categoryClassifier] attempt ${attempt} failed${attempt === 2 ? ', keeping parser labels' : ', retrying'}:`,
        e instanceof Error ? e.message : e
      );
    }
  }
  if (assigned.size === 0) return { reviewed: 0, changed: [], declined: [] };

  const accepted = new Map<string, UnitCategory>();
  const changed: { units: string[]; from: UnitCategory; to: UnitCategory; evidence: EvidenceKind[] }[] = [];
  const declined: { units: string[]; kept: UnitCategory; proposed: UnitCategory; evidence: EvidenceKind[] }[] = [];
  for (const c of candidates) {
    const proposal = assigned.get(c.key);
    if (!proposal) continue;
    switch (gateCategoryProposal(c.prior, proposal.category, proposal.evidence)) {
      case 'accept':
        accepted.set(c.key, proposal.category);
        changed.push({ units: c.unitNumbers, from: c.prior, to: proposal.category, evidence: proposal.evidence });
        break;
      case 'decline':
        declined.push({ units: c.unitNumbers, kept: c.prior, proposed: proposal.category, evidence: proposal.evidence });
        break;
      case 'noop':
        break;
    }
  }
  if (accepted.size === 0) return { reviewed: candidates.length, changed, declined };

  // Re-derive each row's key the same way collectCategoryCandidates did, so the
  // accepted correction lands on exactly the rows that were put up for review.
  for (const u of units) {
    const prior = (u.category ?? 'residential') as UnitCategory;
    const to = accepted.get(shapeKeyOf(u));
    if (!to || to === prior) continue;
    u.category = to;
    // Ancillary income lines are the only rows excluded from the unit count.
    u.includeInUnitCount = to !== 'non_unit_income';
  }
  return { reviewed: candidates.length, changed, declined };
}
