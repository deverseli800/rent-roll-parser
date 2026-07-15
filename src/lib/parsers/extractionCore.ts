import type Anthropic from '@anthropic-ai/sdk';
import type { MVPUnit, UnitStatus, StatedSummaryStats, ProgressEvent } from '../types';
import { extractStructured, MODELS, modelLabel, type AIUsage } from './aiClient';
import { countByStatus, normalizeOccupancyRatePct, reconcileOccupiedCount } from '../utils/occupancy';

/**
 * Shared extraction schema, prompt, normalization, and self-verification
 * used by both the Excel and PDF parsers.
 */

// JSON Schema for structured output (structured-outputs compatible subset:
// no numeric/string constraints, additionalProperties:false everywhere).
export const EXTRACTION_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['propertyName', 'statedTotalUnits', 'statedSummary', 'units'],
  properties: {
    propertyName: { type: ['string', 'null'] },
    statedTotalUnits: {
      type: ['number', 'null'],
      description: 'Total unit count stated IN the document (not your count)',
    },
    statedSummary: {
      type: 'object',
      additionalProperties: false,
      required: ['totalMonthlyRent', 'totalSqft', 'occupancyRate', 'occupiedUnits', 'vacantUnits'],
      properties: {
        totalMonthlyRent: { type: ['number', 'null'] },
        totalSqft: { type: ['number', 'null'] },
        occupancyRate: { type: ['number', 'null'] },
        occupiedUnits: { type: ['number', 'null'] },
        vacantUnits: { type: ['number', 'null'] },
      },
    },
    units: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['unitNumber', 'status', 'monthlyRent', 'tenantName'],
        properties: {
          unitNumber: { type: 'string' },
          status: {
            type: 'string',
            enum: ['occupied', 'vacant', 'notice', 'model', 'down', 'applicant'],
          },
          monthlyRent: { type: ['number', 'null'] },
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
- tenantName: as displayed ("Last, First" stays "Last, First"). Placeholder text like "VACANT" -> null.
- unitType: copy the EXACT text shown (e.g. "4/1" stays "4/1" — do NOT expand to "4BR/1BA"; "2/1.00" stays "2/1.00"). If the document has ANY unit type / floorplan / bedrooms-baths / use-type column, ALWAYS populate unitType from it for every unit (commercial use codes like "CM" or "Store" count). null only when no such column exists.
- unitSqft: number or null.
- Dates (moveInDate, moveOutDate, leaseStartDate, leaseEndDate): ISO YYYY-MM-DD or null.
- leaseStatus: the raw status text from the document if a status column exists, else null.
- Use null for any field the document does not provide. NEVER guess values.
- CONSISTENCY OVER LENGTH: in long documents, populate every field for EVERY unit through the very last page/row. Do not stop filling optional fields (dates, sqft, type) partway through.

DUPLICATES: if the same unit appears on multiple rows (e.g., current resident + applicant, or vacant + pending lease), output it ONCE using the row that describes CURRENT occupancy (prefer occupied/notice over applicant over vacant).

MULTI-PROPERTY DOCUMENTS: some documents cover multiple buildings/properties. Extract units from ALL of them. Different buildings can each have a unit "1A" — that is not a duplicate; output both.

STATED TOTALS: separately report any totals STATED in the document itself (total unit count, total monthly rent, occupancy) in statedTotalUnits/statedSummary. These must come from the document text, not from your own arithmetic. If the document states an ANNUAL total rent, convert to monthly (divide by 12). If multiple properties each state totals, sum them.

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

export function toStatedSummaryStats(r: ExtractionResult): StatedSummaryStats | null {
  const s = r.statedSummary;
  const hasAny =
    r.statedTotalUnits !== null ||
    (s && (s.totalMonthlyRent !== null || s.totalSqft !== null ||
      s.occupancyRate !== null || s.occupiedUnits !== null || s.vacantUnits !== null));
  if (!hasAny) return null;
  return {
    totalUnits: r.statedTotalUnits ?? null,
    totalMonthlyRent: s?.totalMonthlyRent ?? null,
    totalSqft: s?.totalSqft ?? null,
    // Excel percent cells extract as fractions (92.31% -> 0.9231) — store 0-100.
    occupancyRate: normalizeOccupancyRatePct(s?.occupancyRate ?? null),
    occupiedUnits: s?.occupiedUnits ?? null,
    vacantUnits: s?.vacantUnits ?? null,
  };
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
  if (statedRent !== null && statedRent > 0) {
    hasStatedAnchors = true;
    const sum = r.units.reduce((s, u) => s + (u.monthlyRent ?? 0), 0);
    const tol = Math.max(5, statedRent * 0.005);
    // When the unit count matches the stated count and the sum only EXCEEDS the
    // stated total, the document's total likely excludes other income (antenna,
    // laundry) that legitimately belongs to units — not an extraction failure.
    const excusableExcess = countMatches && sum > statedRent && sum <= statedRent * 1.05;
    if (Math.abs(sum - statedRent) > tol && !excusableExcess) {
      let hint = '';
      if (sum > statedRent * 1.02) {
        hint = ' — the extracted rents are likely each unit\'s TOTAL charges (or market rent) instead of the base RENT charge line; use only the base rent charge per unit';
      } else if (sum < statedRent * 0.98) {
        hint = ' — you likely missed units, or used the tenant-paid portion instead of the full contract rent';
      }
      issues.push(
        `Document states total monthly rent ${statedRent.toFixed(2)} but extracted rents sum to ${sum.toFixed(2)}${hint}`
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
  event?: Pick<ProgressEvent, 'kind' | 'message'>
) => void;

export async function runExtractionLadder(
  makeContent: (feedback?: string) => Anthropic.ContentBlockParam[],
  usages: AIUsage[],
  report?: ProgressReporter,
  subject?: string
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
      const { data, usage } = await extractStructured<ExtractionResult>({
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
      usages.push(usage);
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
          totalMonthlyRent: null, totalSqft: null, occupancyRate: null,
          occupiedUnits: null, vacantUnits: null,
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
