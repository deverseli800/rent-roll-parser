import type Anthropic from '@anthropic-ai/sdk';
import type { MVPUnit, UnitStatus, StatedSummaryStats, ProgressEvent } from '../types';
import { extractStructured, MaxTokensError, MODELS, modelLabel, type AIUsage } from './aiClient';
import { countByStatus, normalizeOccupancyRatePct, reconcileOccupiedCount } from '../utils/occupancy';

/**
 * Shared extraction schema, prompt, normalization, and self-verification
 * used by both the Excel and PDF parsers.
 */

// Stated totals use a -1 sentinel instead of null: the structured-outputs
// compiler limits schemas to 16 union-typed parameters, and the per-unit
// fields need the unions more (a forced 0/-1 on every unit would inflate
// output tokens; a -1 on a handful of stated totals costs nothing).
// normalizeStatedSentinels() converts them back to null after parsing.
const statedNum = {
  type: 'number',
  description: 'Value STATED in the document; -1 if the document does not state one (never compute it yourself)',
} as const;

// JSON Schema for structured output (structured-outputs compatible subset:
// no numeric/string constraints, additionalProperties:false everywhere).
export const EXTRACTION_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['propertyName', 'statedTotalUnits', 'statedSummary', 'units'],
  properties: {
    propertyName: { type: ['string', 'null'] },
    statedTotalUnits: {
      type: 'number',
      description: 'Total unit count stated IN the document (not your count); -1 if the document does not state one',
    },
    statedSummary: {
      type: 'object',
      additionalProperties: false,
      required: ['totalMonthlyRent', 'totalMarketRent', 'totalSqft', 'occupancyRate', 'occupiedUnits', 'vacantUnits'],
      properties: {
        totalMonthlyRent: statedNum,
        totalMarketRent: statedNum,
        totalSqft: statedNum,
        occupancyRate: statedNum,
        occupiedUnits: statedNum,
        vacantUnits: statedNum,
      },
    },
    units: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        // The four rent-component fields are REQUIRED (nullable) on purpose:
        // grammar compilation cost grows explosively with the number of
        // OPTIONAL properties in a strict object (making them optional pushed
        // this object to 11 optional keys and timed out compilation on the
        // fast model), while required-nullable keys compile like the original
        // schema. Union budget: 14 of the 16 allowed union-typed parameters.
        required: ['unitNumber', 'status', 'monthlyRent', 'marketRent', 'subsidyRent', 'employeeDiscount', 'concession', 'tenantName'],
        properties: {
          unitNumber: { type: 'string' },
          status: {
            type: 'string',
            enum: ['occupied', 'vacant', 'notice', 'model', 'down', 'applicant'],
          },
          monthlyRent: { type: ['number', 'null'] },
          marketRent: { type: ['number', 'null'], description: 'Market/asking rent; null when the document has no market rent column' },
          subsidyRent: { type: ['number', 'null'], description: 'Subsidy/HAP portion of monthlyRent; null when not shown separately' },
          employeeDiscount: { type: ['number', 'null'], description: 'Recurring employee/manager discount, sign as displayed; null when none' },
          concession: { type: ['number', 'null'], description: 'Recurring concession/credit, sign as displayed; null when none' },
          tenantName: { type: ['string', 'null'] },
          unitSqft: { type: ['number', 'null'] },
          unitType: { type: ['string', 'null'] },
          leaseStatus: { type: ['string', 'null'] },
          moveInDate: { type: ['string', 'null'] },
          moveOutDate: { type: ['string', 'null'] },
          leaseStartDate: { type: ['string', 'null'] },
          leaseEndDate: { type: ['string', 'null'] },
        },
      },
    },
  },
};

export interface ExtractedUnit {
  unitNumber: string;
  status: UnitStatus;
  monthlyRent: number | null;
  marketRent?: number | null;
  subsidyRent?: number | null;
  employeeDiscount?: number | null;
  concession?: number | null;
  tenantName: string | null;
  unitSqft?: number | null;
  unitType?: string | null;
  leaseStatus?: string | null;
  moveInDate?: string | null;
  moveOutDate?: string | null;
  leaseStartDate?: string | null;
  leaseEndDate?: string | null;
}

export interface ExtractionResult {
  propertyName: string | null;
  statedTotalUnits: number | null;
  statedSummary: {
    totalMonthlyRent: number | null;
    totalMarketRent?: number | null;
    totalSqft: number | null;
    occupancyRate: number | null;
    occupiedUnits: number | null;
    vacantUnits: number | null;
  };
  units: ExtractedUnit[];
}

export const EXTRACTION_RULES = `You are extracting unit-level data from a rent roll document. Accuracy is critical: do not miss ANY units and do not invent units.

WHAT COUNTS AS A UNIT (one output row each):
- Residential apartments (including superintendent/employee units, rent-stabilized units)
- Commercial spaces listed as units: stores, retail, offices, professional space, restaurants ("Store #1", "C1", "Comm 1", etc.)
- Parking/garage/antenna/laundry ONLY if listed as line items alongside units with their own rent
- Vacant units (tenant blank or "VACANT")

WHAT IS NOT A UNIT (never output):
- Summary/total/subtotal rows, occupancy statistics, averages
- Section or building headers (addresses, "Building A", property names)
- Charge/fee line items under a unit (RENT, PETRENT, PARKING, SEC8, CONCESSION, etc.) — these belong to the unit above them
- Unit-TYPE aggregate rows: any row describing a GROUP of units (a "# of Units" count, unit-type grouping like "Residential Market Rental - Studio ... 40 units", averages per type). NEVER fabricate individual units from an aggregate row (do not invent "Studio 1", "Studio 2", ...). If the document provides ONLY aggregate groupings and no individual unit rows, return an EMPTY units array — an empty array is the correct answer for such documents.
- Template SAMPLE/example rows: bank rent-roll templates ship with example rows (often labeled "Sample" in an ID column, or with placeholder tenants like "Great Donut Shop, LLC"). These are not real units.
- Column headers, legends, footnotes, signature lines

MULTI-SECTION DOCUMENTS: if the same units appear in BOTH a rent roll section and a billing/arrears/charge-summary section, the rent roll section is the source of truth for occupancy, tenant, and rent (the billing section may be stale). Extract each unit once. Units with unusual identifiers (GRND, BSMT, WLKIN, STORE, garage) are still units when they appear in the rent roll with their own line.

FIELD RULES:
- unitNumber: EXACTLY as displayed in the document (keep prefixes/suffixes; do not renumber). REQUIRED.
- status: occupied | vacant | notice | model | down | applicant.
  "Current"/"Occupied"/"C"/tenant present = occupied. "Vacant"/"V"/"Vacant-Unrented" = vacant.
  "Notice"/"NTV"/"Occupied-NTV" = notice. "Applicant"/"Pending"/"Approved" = applicant.
  "Model" = model. "Down"/"Offline" = down.
  A unit with a real tenant name is occupied even if rent is 0 (e.g., a super).
- monthlyRent: the ACTUAL/current MONTHLY rent being charged (number, no $ or commas).
  If the document shows only an ANNUAL rent for a unit, divide by 12 (round to 2 decimals).
  If a rent column shows both actual and market/projected rent, use the actual in-place rent.
  ITEMIZED CHARGE BLOCKS: many reports list each unit as a block of charge-code rows
  (e.g. "Rent 1,196.00", "Trash Removal 10.00", "Pet Rent 35.00") followed by a
  "Charge Total"/"Total" line. monthlyRent = the RENT charge row ONLY (rent-type codes:
  Rent/rnt/comm; include a rent-subsidy row like "Housing Assistance Rent"/Section 8 when
  it is the unit's rent or supplements a below-market tenant portion). NEVER use the
  Charge Total line — it adds trash/pet/amenity/parking fees. NEVER use Market Rent.
  If the base rent column is empty but the unit's recurring amount appears in an adjacent income column
  (e.g., "Monthly Other Income" for an antenna/laundry/cell-tower tenant), use that amount as the unit's
  monthlyRent — even though the document's stated base-rent total may exclude it (that is expected;
  do not drop the amount just to make totals match).
  Vacant unit with blank/0 rent -> null or 0 as shown.
- marketRent: the unit's MARKET/asking/scheduled rent when the document has such a column
  (common names: "Market Rent", "Market", "Scheduled Rent", "Gross Potential"). Populate it
  for EVERY unit that shows a value — including vacant units. null when no market rent column
  exists.
- subsidyRent: the SUBSIDY portion of the unit's rent when shown separately (Section 8 / HAP /
  "Housing Assistance" / "Subsidy" columns or charge rows). monthlyRent must still be the TOTAL
  contract rent (tenant portion + subsidy); subsidyRent reports the subsidy component so
  tenant-paid rent can be derived as monthlyRent - subsidyRent. null when the document shows no
  separate subsidy amount.
- employeeDiscount: a recurring employee/manager discount shown for the unit (charge codes like
  "EMPL", "Employee Discount", "Manager Credit"). Keep the sign as displayed (usually negative).
  null when none.
- concession: a recurring monthly concession/credit shown for the unit (charge codes like "CONC",
  "Concession", "Rent Credit"). Keep the sign as displayed (usually negative). Do NOT subtract
  concessions from monthlyRent — report them separately. null when none.
- tenantName: as displayed ("Last, First" stays "Last, First"). Placeholder text like "VACANT" -> null.
- unitType: copy the EXACT text shown (e.g. "4/1" stays "4/1" — do NOT expand to "4BR/1BA"; "2/1.00" stays "2/1.00"). If the document has ANY unit type / floorplan / bedrooms-baths / use-type column, ALWAYS populate unitType from it for every unit (commercial use codes like "CM" or "Store" count). null only when no such column exists.
- unitSqft: number or null.
- Dates (moveInDate, moveOutDate, leaseStartDate, leaseEndDate): ISO YYYY-MM-DD or null.
- leaseStatus: the raw status text from the document if a status column exists, else null.
- Use null for any field the document does not provide. NEVER guess values.
- CONSISTENCY OVER LENGTH: in long documents, populate every field for EVERY unit through the very last page/row. Do not stop filling optional fields (dates, sqft, type) partway through.

DUPLICATES: if the same unit appears on multiple rows (e.g., current resident + applicant, or vacant + pending lease), output it ONCE using the row that describes CURRENT occupancy (prefer occupied/notice over applicant over vacant).

MULTI-PROPERTY DOCUMENTS: some documents cover multiple buildings/properties. Extract units from ALL of them. Different buildings can each have a unit "1A" — that is not a duplicate; output both.

STATED TOTALS: separately report any totals STATED in the document itself (total unit count, total monthly rent, occupancy) in statedTotalUnits/statedSummary. These must come from the document text, not from your own arithmetic. If the document states an ANNUAL total rent, convert to monthly (divide by 12). If multiple properties each state totals, sum them. When the document shows MULTIPLE total figures, statedSummary.totalMonthlyRent must be the total of CURRENT/ACTUAL RENT — the figure matching the rent column you extracted per unit — NOT a market/potential/scheduled rent total, and NOT a total-charges figure that adds fees (trash, pet, parking) on top of rent. A stated market/potential/scheduled rent total goes in statedSummary.totalMarketRent instead; if the document states ONLY a market-rent total and no actual-rent total, put it in totalMarketRent and report totalMonthlyRent as -1. For statedTotalUnits and every statedSummary field, report -1 when the document does not state that value (do NOT compute it yourself; -1 means "not stated").

Before finishing, recount: every unit row in the document must appear exactly once in your output.`;

const STATUS_MAPPINGS: Record<string, UnitStatus> = {
  occupied: 'occupied', current: 'occupied', c: 'occupied', leased: 'occupied',
  rented: 'occupied', resident: 'occupied', 'pending renewal': 'occupied',
  'occupied-ntv': 'notice', vacant: 'vacant', 'vacant unit': 'vacant',
  'vacant-leased': 'vacant', v: 'vacant', available: 'vacant', ready: 'vacant',
  'vacant-ready': 'vacant', 'vacant-unrented': 'vacant', notice: 'notice',
  ntv: 'notice', 'notice to vacate': 'notice', n: 'notice', model: 'model',
  m: 'model', down: 'down', d: 'down', offline: 'down', applicant: 'applicant',
  application: 'applicant', pending: 'applicant', approved: 'applicant',
};

export function normalizeStatus(value: unknown): UnitStatus {
  if (!value) return 'vacant';
  const normalized = String(value).toLowerCase().trim();
  const exact = STATUS_MAPPINGS[normalized];
  if (exact) return exact;
  // Compound statuses ("Occupied No Notice", "Vacant Unrented Ready",
  // "Notice Unrented"): classify by the strongest keyword.
  if (/notice|ntv/.test(normalized) && !/no\s*notice/.test(normalized)) return 'notice';
  if (/vacant|available|unrented/.test(normalized)) return 'vacant';
  if (/model/.test(normalized)) return 'model';
  if (/down|offline|admin/.test(normalized)) return 'down';
  if (/applicant|pending|approved|future/.test(normalized)) return 'applicant';
  if (/occupied|current|leased|eviction/.test(normalized)) return 'occupied';
  return 'occupied';
}

/** Placeholder-only strings ("--/--", "-/-", "--") carry no information */
function cleanPlaceholder(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  if (!s || /^[-–—/\\ .]*$/.test(s)) return null;
  return s;
}

/** Convert an ExtractionResult's units to MVPUnit[] */
export function toMVPUnits(units: ExtractedUnit[], sourcePage?: number): MVPUnit[] {
  return units.map((u, i) => ({
    unitNumber: String(u.unitNumber).trim(),
    status: normalizeStatus(u.status),
    monthlyRent: u.monthlyRent ?? null,
    marketRent: u.marketRent ?? null,
    subsidyRent: u.subsidyRent ?? null,
    employeeDiscount: u.employeeDiscount ?? null,
    concession: u.concession ?? null,
    tenantName: cleanPlaceholder(u.tenantName),
    unitSqft: u.unitSqft ?? null,
    unitType: cleanPlaceholder(u.unitType),
    leaseStatus: u.leaseStatus ?? null,
    moveInDate: u.moveInDate ?? null,
    moveOutDate: u.moveOutDate ?? null,
    leaseStartDate: u.leaseStartDate ?? null,
    leaseEndDate: u.leaseEndDate ?? null,
    sourceRow: i + 1,
    ...(sourcePage !== undefined ? { sourcePage } : {}),
  }));
}

/**
 * Convert the -1 "not stated" sentinels (see statedNum above) back to null.
 * Must run on every EXTRACTION_SCHEMA parse before verification or reporting.
 */
export function normalizeStatedSentinels(r: ExtractionResult): ExtractionResult {
  const n = (v: number | null | undefined): number | null =>
    v === null || v === undefined || v < 0 ? null : v;
  r.statedTotalUnits = n(r.statedTotalUnits);
  if (r.statedSummary) {
    r.statedSummary.totalMonthlyRent = n(r.statedSummary.totalMonthlyRent);
    r.statedSummary.totalMarketRent = n(r.statedSummary.totalMarketRent);
    r.statedSummary.totalSqft = n(r.statedSummary.totalSqft);
    r.statedSummary.occupancyRate = n(r.statedSummary.occupancyRate);
    r.statedSummary.occupiedUnits = n(r.statedSummary.occupiedUnits);
    r.statedSummary.vacantUnits = n(r.statedSummary.vacantUnits);
  }
  return r;
}

export function toStatedSummaryStats(r: ExtractionResult): StatedSummaryStats | null {
  const s = r.statedSummary;
  const hasAny =
    r.statedTotalUnits !== null ||
    (s && (s.totalMonthlyRent !== null || (s.totalMarketRent ?? null) !== null || s.totalSqft !== null ||
      s.occupancyRate !== null || s.occupiedUnits !== null || s.vacantUnits !== null));
  if (!hasAny) return null;
  return {
    totalUnits: r.statedTotalUnits ?? null,
    totalMonthlyRent: s?.totalMonthlyRent ?? null,
    totalMarketRent: s?.totalMarketRent ?? null,
    totalSqft: s?.totalSqft ?? null,
    // Excel percent cells extract as fractions (92.31% -> 0.9231) — store 0-100.
    occupancyRate: normalizeOccupancyRatePct(s?.occupancyRate ?? null),
    occupiedUnits: s?.occupiedUnits ?? null,
    vacantUnits: s?.vacantUnits ?? null,
  };
}

// ---------------------------------------------------------------------------
// Stated-summary preview: a quick first AI pass that reads ONLY the totals the
// document states about itself (unit count, occupancy, total rent/sqft) so the
// UI can show something within seconds, while the full unit-level extraction
// (minutes for large documents) runs afterwards.
//
// The document content block(s) are shared verbatim with the full extraction
// and carry cache_control, so the second call reads the document from the
// prompt cache (~0.1x input price) instead of paying for it twice. Two
// non-obvious constraints (both verified empirically):
//   1. The cache entry only becomes readable once this call streams, which is
//      why the preview runs to completion BEFORE the ladder starts.
//   2. The structured-output schema is rendered into the prompt prefix, so a
//      different schema breaks the cache. The preview therefore uses the SAME
//      EXTRACTION_SCHEMA and instructs the model to return units: [] — the
//      schema allows an empty array and the output stays tiny.
// ---------------------------------------------------------------------------

const PREVIEW_PROMPT = `Report ONLY the summary information this rent roll document STATES about itself — do NOT extract or enumerate individual units. Return "units" as an EMPTY array []; a separate full extraction handles the units.

Look for a summary/totals section (often at the very top or bottom): "Total Units", a "Summary" block, occupancy percentages, total monthly rent / total sqft rows, current-vs-vacant unit counts.
- propertyName: the property name shown in the document, if any.
- statedTotalUnits: the total unit count the document STATES (not your own count of rows); -1 if not stated.
- statedSummary: totals the document states. Report -1 for anything the document does not explicitly state — do NOT compute, sum, or estimate values yourself.
  When the document shows MULTIPLE summary figures, report the CURRENT/actual ones: totalMonthlyRent is the current RENT total (not market/scheduled/potential rent, and not a total-charges figure that adds fees); a stated market/potential rent total goes in totalMarketRent; occupancyRate is current physical occupancy (not projected, leased %, or economic occupancy).
- units: [] — always empty in this pass.
This is a fast first pass. Respond as quickly as possible.`;

export interface PreviewData {
  propertyName: string | null;
  statedUnitCount: number | null;
  statedSummaryStats: StatedSummaryStats | null;
}

/**
 * Quick stated-summary read. `docContent` must be the exact document block(s)
 * the full extraction will send (same bytes, cache_control included) so the
 * prompt-cache prefix is shared. Never throws — the preview is a UX
 * enhancement, not a pipeline dependency.
 */
export async function extractStatedPreview(
  docContent: Anthropic.ContentBlockParam[],
  usages: AIUsage[],
  report?: ProgressReporter,
  subject?: string
): Promise<PreviewData | null> {
  const where = subject ? ` of ${subject}` : '';
  report?.('extracting', `quick scan${where} — reading the document's stated totals`, {
    kind: 'info',
    message: `Quick first pass: reading the summary totals the document states about itself`,
  });
  try {
    const { data, usage } = await extractStructured<ExtractionResult>({
      model: MODELS.fast,
      // Same schema as the full extraction — REQUIRED for the cache prefix to
      // match (the schema is part of the rendered prompt). See note above.
      content: [...docContent, { type: 'text', text: PREVIEW_PROMPT }],
      schema: EXTRACTION_SCHEMA,
      maxTokens: 16000, // adaptive thinking shares this budget; the answer itself is tiny
    });
    usages.push(usage);
    normalizeStatedSentinels(data);
    const preview: PreviewData = {
      propertyName: data.propertyName ?? null,
      statedUnitCount: data.statedTotalUnits ?? null,
      statedSummaryStats: toStatedSummaryStats({ ...data, units: [] }),
    };

    const s = preview.statedSummaryStats;
    const parts: string[] = [];
    if (preview.statedUnitCount !== null) parts.push(`${preview.statedUnitCount} units`);
    if (s?.occupancyRate != null) parts.push(`${s.occupancyRate.toFixed(1)}% occupancy`);
    else if (s?.occupiedUnits != null) parts.push(`${s.occupiedUnits} occupied`);
    if (s?.totalMonthlyRent != null) parts.push(`$${Math.round(s.totalMonthlyRent).toLocaleString('en-US')} monthly rent`);
    const label = preview.propertyName ? `${preview.propertyName}: ` : '';
    report?.('extracting', undefined, {
      kind: 'preview',
      message: parts.length > 0
        ? `Document summary — ${label}${parts.join(', ')}. Now extracting each individual unit`
        : 'The document states no summary totals of its own — proceeding straight to full unit extraction',
      preview,
    });
    return preview;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    report?.('extracting', undefined, {
      kind: 'info',
      message: `Quick summary scan failed (${msg.slice(0, 100)}) — proceeding to full extraction`,
    });
    return null;
  }
}

export interface VerificationOutcome {
  ok: boolean;
  issues: string[];
  hasStatedAnchors: boolean; // whether the doc gave us anything to verify against
}

/**
 * Self-verification: compare extracted units against totals the document states.
 */
export function verifyAgainstStated(r: ExtractionResult): VerificationOutcome {
  const issues: string[] = [];
  let hasStatedAnchors = false;

  if (r.statedTotalUnits !== null && r.statedTotalUnits > 0) {
    hasStatedAnchors = true;
    if (r.units.length !== r.statedTotalUnits) {
      issues.push(
        `Document states ${r.statedTotalUnits} total units but ${r.units.length} were extracted`
      );
    }
  }

  const countMatches =
    r.statedTotalUnits !== null && r.units.length === r.statedTotalUnits;

  const statedRent = r.statedSummary?.totalMonthlyRent ?? null;
  const statedMarket = r.statedSummary?.totalMarketRent ?? null;
  const sumMarket = r.units.reduce((s, u) => s + (u.marketRent ?? 0), 0);
  if (statedRent !== null && statedRent > 0) {
    hasStatedAnchors = true;
    const sum = r.units.reduce((s, u) => s + (u.monthlyRent ?? 0), 0);
    const tol = Math.max(5, statedRent * 0.005);
    // When the unit count matches the stated count and the sum only EXCEEDS the
    // stated total, the document's total likely excludes other income (antenna,
    // laundry) that legitimately belongs to units — not an extraction failure.
    const excusableExcess = countMatches && sum > statedRent && sum <= statedRent * 1.05;
    // Stated-total misidentification guard: when the extracted MARKET rents sum
    // to the "stated rent total", the total was actually the market figure (the
    // model put it in the wrong slot). The per-unit rents are fine — reclassify
    // the stated value instead of failing a correct extraction.
    const statedRentIsMarketTotal =
      Math.abs(sum - statedRent) > tol &&
      sumMarket > 0 &&
      Math.abs(sumMarket - statedRent) <= Math.max(5, statedRent * 0.005);
    if (statedRentIsMarketTotal) {
      if (statedMarket === null) r.statedSummary.totalMarketRent = statedRent;
      r.statedSummary.totalMonthlyRent = null;
    } else if (Math.abs(sum - statedRent) > tol && !excusableExcess) {
      let hint = '';
      if (sum > statedRent * 1.02) {
        hint = ' — the extracted rents are likely each unit\'s TOTAL charges (or market rent) instead of the base RENT charge line; use only the base rent charge per unit';
      } else if (sum < statedRent * 0.98) {
        hint = ' — you likely missed units, or used the tenant-paid portion instead of the full contract rent. But if the stated figure is actually a MARKET/potential rent total, report it in statedSummary.totalMarketRent (not totalMonthlyRent) and keep the actual in-place rents';
      }
      issues.push(
        `Document states total monthly rent ${statedRent.toFixed(2)} but extracted rents sum to ${sum.toFixed(2)}${hint}`
      );
    }
  }

  // Market-rent anchor: when the document states a market total AND the sheet
  // has a well-populated market rent column, their disagreement means the
  // column was misread (or half-skipped).
  if (statedMarket !== null && statedMarket > 0) {
    hasStatedAnchors = true;
    const withMarket = r.units.filter(u => u.marketRent !== null && u.marketRent !== undefined).length;
    const tol = Math.max(5, statedMarket * 0.005);
    if (withMarket >= r.units.length * 0.8 && Math.abs(sumMarket - statedMarket) > tol) {
      issues.push(
        `Document states total market rent ${statedMarket.toFixed(2)} but extracted market rents sum to ${sumMarket.toFixed(2)} — check the market rent column for every unit (including vacant units)`
      );
    }
  }

  // Absolute date-coverage check: institutional rolls of 60+ units virtually
  // always carry lease/move-in dates for occupied units. All-three-empty means
  // the model skipped the columns wholesale.
  if (r.units.length >= 60) {
    const occ = r.units.filter(u => u.status === 'occupied' || u.status === 'notice');
    if (occ.length >= 40) {
      const fillAny = occ.filter(u => u.leaseStartDate || u.leaseEndDate || u.moveInDate).length / occ.length;
      if (fillAny < 0.05) {
        issues.push(
          'No lease dates or move-in dates were extracted for any occupied unit. If the document has lease/move-in/expiration date columns, populate leaseStartDate/leaseEndDate/moveInDate for EVERY unit that shows them. (Ignore this if the document truly has no date columns.)'
        );
      }
    }
  }

  // Lazy-extraction detection: a field that is well-populated early in the unit
  // list but goes empty later usually means the model stopped filling optional
  // fields partway through a long document (real documents drop columns for
  // whole sections, not gradually).
  if (r.units.length >= 60) {
    const q = Math.floor(r.units.length / 4);
    const first = r.units.slice(0, q);
    const last = r.units.slice(-q);
    const OPTIONAL_FIELDS: (keyof ExtractedUnit)[] = [
      'leaseStartDate', 'leaseEndDate', 'moveInDate', 'moveOutDate', 'unitSqft', 'unitType', 'tenantName',
    ];
    for (const f of OPTIONAL_FIELDS) {
      const fill = (arr: ExtractedUnit[]) =>
        arr.filter(u => u[f] !== null && u[f] !== undefined && u[f] !== '').length / arr.length;
      const fFirst = fill(first);
      const fLast = fill(last);
      if (fFirst >= 0.5 && fLast < fFirst * 0.4) {
        issues.push(
          `Field "${f}" is populated for ${(fFirst * 100).toFixed(0)}% of the first units but only ${(fLast * 100).toFixed(0)}% of the last units — you likely stopped filling this field partway through. Populate it for EVERY unit where the document shows a value, all the way to the end.`
        );
      }
    }
  }

  const statedOcc = r.statedSummary?.occupiedUnits ?? null;
  if (statedOcc !== null) {
    hasStatedAnchors = true;
    const reconciliation = reconcileOccupiedCount(statedOcc, countByStatus(r.units));
    // Escalation policy: retry on a bigger model only for gross mismatches
    // (>5%) that reconciliation can't explain — escalating over definitional
    // slack (notice/model/down counted as occupied) would burn tokens to
    // re-extract an already-correct result.
    if (!reconciliation.ok && reconciliation.diff > Math.max(1, statedOcc * 0.05)) {
      issues.push(`Document states ${statedOcc} occupied units but ${reconciliation.physical} were extracted as occupied/notice`);
    }
  }

  // Sanity checks that need no stated anchors
  if (r.units.length === 0) {
    issues.push('No units extracted');
  }

  return { ok: issues.length === 0, issues, hasStatedAnchors };
}

/**
 * Run the full extraction ladder for one document/sheet:
 *   1. Sonnet 5.
 *   2. If verification fails: Opus 4.8 with feedback, keep the better attempt;
 *      if still failing and the doc states totals: Fable 5 with feedback.
 *   3. If verification "passes" only because the document states no totals
 *      (nothing to check against): run Opus 4.8 as an independent second
 *      opinion; keep the fast result only when both agree on the unit set.
 */
/**
 * Reports parser progress: reporter(stage, detail, event?).
 * `stage`/`detail` drive the throttled "current activity" line; `event`, when
 * present, appends a notable moment to the user-visible timeline (attempt
 * started, verification outcome, escalation) and is never throttled away.
 */
export type ProgressReporter = (
  stage: string,
  detail?: string,
  // `preview` rides along on kind:'preview' events so the job runner can write
  // the stated stats to the record early (shown in the UI while extracting).
  event?: Pick<ProgressEvent, 'kind' | 'message'> & { preview?: PreviewData }
) => void;

// A document's units no longer fit in one 128K-token response once it has
// roughly this many units (~500 output tokens each incl. adaptive thinking).
// Chunk target leaves ample headroom per call.
const TARGET_UNITS_PER_CHUNK = 150;
// Above this many stated units a single call is a mathematical certainty to
// truncate — skip the wasted attempt and go straight to chunked mode.
const PROACTIVE_CHUNK_UNITS = 400;
const MIN_CHUNK_ITEMS = 4;

export interface ChunkingOptions {
  /** Total addressable items in the document (numbered sheet rows or PDF pages). */
  itemCount: number;
  itemLabel: 'rows' | 'pages';
  /** Unit count the document states about itself (from the preview), when known. */
  estimatedUnits?: number | null;
  /** Builds the prompt restricted to items start..end (1-based, inclusive). */
  makeChunkContent: (
    range: { start: number; end: number; index: number; total: number },
    feedback?: string
  ) => Anthropic.ContentBlockParam[];
}

/** Boundary-duplicate key: adjacent chunks can both emit the unit whose block
 * straddles the split. Legitimate same-numbered units in different buildings
 * differ in tenant/rent, so the composite key keeps them. */
function chunkDedupeKey(u: ExtractedUnit): string {
  const num = String(u.unitNumber).toUpperCase().replace(/[#\s.,_/\\-]+/g, '');
  return `${num}|${(u.tenantName ?? '').toUpperCase().trim()}|${u.monthlyRent ?? ''}`;
}

/**
 * Extract one item range; on truncation, split the range in half and recurse.
 * Returns partial results in document order.
 */
async function extractRange(
  model: string,
  chunking: ChunkingOptions,
  range: { start: number; end: number; index: number; total: number },
  usages: AIUsage[],
  feedback?: string,
  report?: ProgressReporter,
  subject?: string
): Promise<ExtractionResult[]> {
  const label = `${subject ? subject + ' — ' : ''}${chunking.itemLabel} ${range.start}–${range.end}`;
  try {
    const { data, usage } = await extractStructured<ExtractionResult>({
      model,
      content: chunking.makeChunkContent(range, feedback),
      schema: EXTRACTION_SCHEMA,
      itemToken: '"unitNumber"',
      onHeartbeat: report
        ? ({ items }) => report('extracting', `${label} — ${items} unit${items === 1 ? '' : 's'} extracted so far`)
        : undefined,
    });
    usages.push(usage);
    normalizeStatedSentinels(data);
    report?.('extracting', undefined, {
      kind: 'info',
      message: `Chunk ${range.index}/${range.total} (${chunking.itemLabel} ${range.start}–${range.end}) returned ${data.units.length} units`,
    });
    return [data];
  } catch (e) {
    const span = range.end - range.start + 1;
    if (e instanceof MaxTokensError && span >= MIN_CHUNK_ITEMS * 2) {
      report?.('extracting', undefined, {
        kind: 'info',
        message: `Chunk ${range.index}/${range.total} still exceeded the output limit — splitting ${chunking.itemLabel} ${range.start}–${range.end} in half`,
      });
      const mid = range.start + Math.floor(span / 2) - 1;
      const halves = [
        { ...range, end: mid },
        { ...range, start: mid + 1 },
      ];
      const results = await Promise.all(
        halves.map(h => extractRange(model, chunking, h, usages, feedback, report, subject))
      );
      return results.flat();
    }
    throw e;
  }
}

/**
 * Chunked extraction: split the document into item ranges, extract each with
 * the SAME model, merge in document order. The merged result flows through the
 * ladder's normal whole-document verification, so accuracy gating is unchanged.
 */
async function extractChunked(
  model: string,
  chunking: ChunkingOptions,
  usages: AIUsage[],
  feedback?: string,
  report?: ProgressReporter,
  subject?: string
): Promise<ExtractionResult> {
  const est = chunking.estimatedUnits ?? null;
  const chunkCount = Math.min(
    8,
    Math.max(2, est ? Math.ceil(est / TARGET_UNITS_PER_CHUNK) : 3)
  );
  const per = Math.ceil(chunking.itemCount / chunkCount);
  const ranges = Array.from({ length: chunkCount }, (_, i) => ({
    start: i * per + 1,
    end: Math.min((i + 1) * per, chunking.itemCount),
    index: i + 1,
    total: chunkCount,
  })).filter(r => r.start <= r.end);
  report?.('extracting', undefined, {
    kind: 'info',
    message: `Document is too large for one response — extracting in ${ranges.length} chunks of ~${per} ${chunking.itemLabel} each (${modelLabel(model)}), then merging and verifying against stated totals`,
  });

  // The document prefix is already in the prompt cache (preview / prior
  // attempt streamed it), so parallel chunks all read it at ~0.1x price.
  const parts = (
    await Promise.all(
      ranges.map(r => extractRange(model, chunking, r, usages, feedback, report, subject))
    )
  ).flat();

  const seen = new Set<string>();
  const units: ExtractedUnit[] = [];
  for (const part of parts) {
    for (const u of part.units) {
      const key = chunkDedupeKey(u);
      if (seen.has(key)) continue;
      seen.add(key);
      units.push(u);
    }
  }
  const firstNonNull = <T>(pick: (r: ExtractionResult) => T | null | undefined): T | null => {
    for (const p of parts) {
      const v = pick(p);
      if (v !== null && v !== undefined) return v;
    }
    return null;
  };
  return {
    propertyName: firstNonNull(p => p.propertyName),
    statedTotalUnits: firstNonNull(p => p.statedTotalUnits),
    statedSummary: {
      totalMonthlyRent: firstNonNull(p => p.statedSummary?.totalMonthlyRent),
      totalMarketRent: firstNonNull(p => p.statedSummary?.totalMarketRent),
      totalSqft: firstNonNull(p => p.statedSummary?.totalSqft),
      occupancyRate: firstNonNull(p => p.statedSummary?.occupancyRate),
      occupiedUnits: firstNonNull(p => p.statedSummary?.occupiedUnits),
      vacantUnits: firstNonNull(p => p.statedSummary?.vacantUnits),
    },
    units,
  };
}

export async function runExtractionLadder(
  makeContent: (feedback?: string) => Anthropic.ContentBlockParam[],
  usages: AIUsage[],
  report?: ProgressReporter,
  subject?: string,
  chunking?: ChunkingOptions
): Promise<ExtractionResult> {
  let lastError: Error | null = null;
  let attemptNo = 0;
  const where = subject ? ` on ${subject}` : '';
  // Summarize verification issues for the user-visible timeline.
  const issueSummary = (issues: string[]) => {
    const shown = issues.slice(0, 2).map(i => i.split(' — ')[0]); // drop prompt-side hints
    return `${shown.join('; ')}${issues.length > 2 ? ` (+${issues.length - 2} more)` : ''}`;
  };

  const attempt = async (model: string, feedback?: string) => {
    attemptNo++;
    const label = `${subject ? subject + ' — ' : ''}attempt ${attemptNo} (${modelLabel(model)})`;
    report?.('extracting', label, {
      kind: 'attempt',
      message: `${modelLabel(model)} extracting${where} (attempt ${attemptNo})`,
    });
    try {
      let data: ExtractionResult;
      const certainToTruncate =
        chunking && (chunking.estimatedUnits ?? 0) >= PROACTIVE_CHUNK_UNITS;
      if (certainToTruncate) {
        report?.('extracting', undefined, {
          kind: 'info',
          message: `Document states ${chunking!.estimatedUnits} units — too many for a single response, going straight to chunked extraction`,
        });
        data = await extractChunked(model, chunking!, usages, feedback, report, subject);
      } else {
        try {
          const single = await extractStructured<ExtractionResult>({
            model,
            content: makeContent(feedback),
            schema: EXTRACTION_SCHEMA,
            itemToken: '"unitNumber"',
            onHeartbeat: report
              ? ({ chars, items }) => {
                  const detail = items > 0
                    ? `${label} — ${items} unit${items === 1 ? '' : 's'} extracted so far`
                    : chars > 0
                      ? `${label} — writing document summary (~${Math.round(chars / 1024)}KB streamed)`
                      : `${label} — reading and analyzing the document (no output yet; large documents take several minutes)`;
                  report('extracting', detail);
                }
              : undefined,
          });
          usages.push(single.usage);
          data = single.data;
          normalizeStatedSentinels(data);
        } catch (e) {
          // Truncation is a size problem, not a quality problem — a stronger
          // model produces the same volume of JSON, so escalating cannot fix
          // it. Retry the SAME model in chunked mode instead.
          if (!(e instanceof MaxTokensError) || !chunking) throw e;
          report?.('extracting', undefined, {
            kind: 'info',
            message: `${modelLabel(model)}'s output hit the token limit — the document has more units than fit in one response. Retrying ${modelLabel(model)} in chunked mode (model escalation would not help here)`,
          });
          data = await extractChunked(model, chunking, usages, feedback, report, subject);
        }
      }
      const verification = verifyAgainstStated(data);
      if (verification.ok) {
        report?.('verifying', label, {
          kind: 'verify_pass',
          message: verification.hasStatedAnchors
            ? `${modelLabel(model)} extracted ${data.units.length} units — verified against the document's stated totals`
            : `${modelLabel(model)} extracted ${data.units.length} units — document states no totals to verify against`,
        });
      } else {
        report?.('verifying', label, {
          kind: 'verify_fail',
          message: `${modelLabel(model)}'s result failed self-verification: ${issueSummary(verification.issues)}`,
        });
      }
      return { result: data, verification };
    } catch (e) {
      // A failed attempt (max_tokens, refusal, transient API error) should not
      // kill the whole parse — record it and let the ladder escalate.
      lastError = e instanceof Error ? e : new Error(String(e));
      report?.('verifying', label, {
        kind: 'verify_fail',
        message: `${modelLabel(model)} attempt failed (${lastError.message.slice(0, 120)})`,
      });
      const empty: ExtractionResult = {
        propertyName: null,
        statedTotalUnits: null,
        statedSummary: {
          totalMonthlyRent: null, totalMarketRent: null, totalSqft: null,
          occupancyRate: null, occupiedUnits: null, vacantUnits: null,
        },
        units: [],
      };
      return {
        result: empty,
        verification: {
          ok: false,
          issues: [`extraction attempt failed: ${lastError.message}`],
          hasStatedAnchors: true, // force escalation to the next model
        },
      };
    }
  };

  let best = await attempt(MODELS.fast);

  if (!best.verification.ok) {
    const feedback = best.verification.issues.map(i => `- ${i}`).join('\n');
    report?.('escalating', undefined, {
      kind: 'escalation',
      message: `Escalating to ${modelLabel(MODELS.strong)} with feedback about what went wrong`,
    });
    const retry = await attempt(MODELS.strong, `IMPORTANT — a previous extraction attempt had these problems; fix them:\n${feedback}`);
    best = pickBetterAttempt(best, retry);
    report?.('extracting', undefined, {
      kind: 'decision',
      message: best === retry
        ? `Keeping ${modelLabel(MODELS.strong)}'s result${best.verification.ok ? '' : ' (better of the two, but still imperfect)'}`
        : `${modelLabel(MODELS.strong)} did not improve on ${modelLabel(MODELS.fast)} — keeping the earlier result`,
    });
    if (!best.verification.ok && best.verification.hasStatedAnchors) {
      const fb2 = best.verification.issues.map(i => `- ${i}`).join('\n');
      report?.('escalating', undefined, {
        kind: 'escalation',
        message: `Still failing verification — escalating to ${modelLabel(MODELS.max)} (most capable model)`,
      });
      const retry2 = await attempt(MODELS.max, `IMPORTANT — a previous extraction attempt had these problems; fix them:\n${fb2}`);
      const prev = best;
      best = pickBetterAttempt(best, retry2);
      report?.('extracting', undefined, {
        kind: 'decision',
        message: best === retry2
          ? `Keeping ${modelLabel(MODELS.max)}'s result${best.verification.ok ? '' : ' (best available, some checks still unresolved)'}`
          : `${modelLabel(MODELS.max)} did not improve — keeping the earlier result${prev.verification.ok ? '' : ' (some checks still unresolved)'}`,
      });
    }
  } else if (!best.verification.hasStatedAnchors) {
    // Nothing in the document to verify against — get a second opinion.
    report?.('verifying', undefined, {
      kind: 'info',
      message: `No stated totals to verify against — asking ${modelLabel(MODELS.strong)} for an independent second opinion`,
    });
    const second = await attempt(MODELS.strong);
    const setA = unitNumberMultiset(best.result.units);
    const setB = unitNumberMultiset(second.result.units);
    if (setA !== setB) {
      // Disagreement with no anchors: trust the stronger model.
      best = second.verification.issues.length <= best.verification.issues.length ? second : best;
      report?.('extracting', undefined, {
        kind: 'decision',
        message: `The two models disagreed on the unit list — keeping ${modelLabel(best === second ? MODELS.strong : MODELS.fast)}'s version`,
      });
    } else {
      report?.('extracting', undefined, {
        kind: 'decision',
        message: 'Both models independently extracted the same unit list — high agreement',
      });
    }
  }

  if (best.result.units.length === 0 && lastError) {
    throw lastError; // every attempt errored — surface the real failure
  }
  return best.result;
}

function unitNumberMultiset(units: ExtractedUnit[]): string {
  return units
    .map(u => String(u.unitNumber).toUpperCase().replace(/[#\s.,_/\\-]+/g, ''))
    .sort()
    .join('|');
}

/**
 * Pick the better of two extraction attempts using verification results.
 */
export function pickBetterAttempt(
  a: { result: ExtractionResult; verification: VerificationOutcome },
  b: { result: ExtractionResult; verification: VerificationOutcome }
): { result: ExtractionResult; verification: VerificationOutcome } {
  if (a.verification.ok && !b.verification.ok) return a;
  if (b.verification.ok && !a.verification.ok) return b;
  // Neither (or both) verified: prefer fewer issues, then more units extracted
  if (a.verification.issues.length !== b.verification.issues.length) {
    return a.verification.issues.length < b.verification.issues.length ? a : b;
  }
  return b.result.units.length >= a.result.units.length ? b : a;
}
