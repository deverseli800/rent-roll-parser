import * as XLSX from 'xlsx';
import type { ChargeCategory } from '../types';
import { extractStructured, MODELS, type AIUsage } from './aiClient';
import {
  applyExternalStated,
  CHARGE_TOTAL_LINE,
  normalizeStatus,
  verifyAgainstStated,
  type ExtractionResult,
  type ExtractedUnit,
  type PreviewData,
} from './extractionCore';

/**
 * Deterministic fast path for Excel sheets.
 *
 * One small AI call maps the sheet STRUCTURE (layout, column indices, charge
 * rules, skip/stop markers, stated totals). Code then walks every row: exact
 * digits, no transcription risk, ~50x cheaper than full-AI extraction.
 * Callers verify the result against the document's stated totals and fall back
 * to the full-AI ladder when it does not reconcile.
 */

interface ColumnMap {
  unitNumber: number | null;
  status: number | null;
  monthlyRent: number | null;
  marketRent: number | null;
  subsidyRent: number | null;
  employeeDiscount: number | null;
  concession: number | null;
  tenantName: number | null;
  tenantName2: number | null;
  unitSqft: number | null;
  unitType: number | null;
  moveInDate: number | null;
  moveOutDate: number | null;
  leaseStartDate: number | null;
  leaseEndDate: number | null;
}

// A per-charge-code COLUMN on unit rows (see MAPPER_PROMPT): the column header
// IS the charge code, each unit row carries an amount per code.
interface ChargeColumn {
  header: string;
  index: number;
  kind: 'rent' | 'subsidy' | 'employee_discount' | 'concession' | 'fee';
}

interface SheetStructure {
  layout: 'row' | 'block' | 'unsupported';
  dataStartRow: number; // 1-based, matching the R# labels shown to the mapper
  columns: ColumnMap;
  block: {
    chargeDescCol: number | null;
    chargeAmtCol: number | null;
    rentChargeCodes: string[];
    subsidyChargeCodes: string[];
    employeeDiscountChargeCodes: string[];
    concessionChargeCodes: string[];
  } | null;
  // Row layouts where charge codes are the COLUMN HEADERS (one column per
  // code, often with a per-row "Total Charged" column). [] / null otherwise.
  chargeColumns: ChargeColumn[];
  chargeTotalColumn: number | null;
  skipPatterns: string[];
  stopMarkers: string[];
  statedTotalUnits: number | null;
  statedSummary: {
    totalMonthlyRent: number | null;
    totalMarketRent: number | null;
    totalSqft: number | null;
    occupancyRate: number | null;
    occupiedUnits: number | null;
    vacantUnits: number | null;
  };
  // Unit-row columns NOT mapped to a known field above; captured verbatim into
  // each unit's sourceColumns (e.g. a rent-regulation/lease-type column, a
  // legal/registered rent column, DHCR codes).
  extraColumns: { header: string; index: number }[];
}

/**
 * Document-stated anchors a charge-column walk produces for provenComplete():
 * per-row printed charge totals reconciling with the captured charge lines,
 * their sum reconciling with the column's printed grand total, and an audit for
 * candidate unit rows the walk rejected. Internal to the fast path — never
 * serialized.
 */
interface ChargeColumnAnchor {
  rowsWithTotals: number;      // units carrying a printed per-row charge total
  rowsReconciled: number;      // of those, ones whose charge lines sum to it (±$0.02)
  minRowTotal: number;         // smallest nonzero printed row total
  walkedTotalSum: number;      // sum of all printed row totals the walk captured
  statedGrandTotal: number | null; // the column's printed grand total below the units
  orphanRows: number;          // unit-cell-bearing rows in the walked region the walk rejected
}

type FastPathResult = ExtractionResult & { chargeColumnAnchor?: ChargeColumnAnchor };

// How far past a unit's anchor row the walk will look for that unit's scalar
// attributes in a block layout. Charge blocks in these exports run a handful of
// rows; the cap keeps a runaway scan from reaching a later section of the sheet.
const SCALAR_SCAN_LIMIT = 20;

const numOrNull = { type: ['number', 'null'] } as const;
// Column indices use -1 as "absent" instead of null: the structured-outputs
// compiler limits schemas to 16 union-typed parameters.
const colIdx = { type: 'number', description: '0-based cell index, or -1 if this field is not present' } as const;

const STRUCTURE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['layout', 'dataStartRow', 'columns', 'block', 'chargeColumns', 'chargeTotalColumn', 'skipPatterns', 'stopMarkers', 'statedTotalUnits', 'statedSummary', 'extraColumns'],
  properties: {
    layout: { type: 'string', enum: ['row', 'block', 'unsupported'] },
    dataStartRow: { type: 'number' },
    columns: {
      type: 'object',
      additionalProperties: false,
      required: ['unitNumber', 'status', 'monthlyRent', 'marketRent', 'subsidyRent', 'employeeDiscount', 'concession', 'tenantName', 'tenantName2', 'unitSqft', 'unitType', 'moveInDate', 'moveOutDate', 'leaseStartDate', 'leaseEndDate'],
      properties: {
        unitNumber: colIdx, status: colIdx, monthlyRent: colIdx, marketRent: colIdx,
        subsidyRent: colIdx, employeeDiscount: colIdx, concession: colIdx,
        tenantName: colIdx, tenantName2: colIdx, unitSqft: colIdx, unitType: colIdx,
        moveInDate: colIdx, moveOutDate: colIdx,
        leaseStartDate: colIdx, leaseEndDate: colIdx,
      },
    },
    block: {
      type: 'object',
      additionalProperties: false,
      required: ['chargeDescCol', 'chargeAmtCol', 'rentChargeCodes', 'subsidyChargeCodes', 'employeeDiscountChargeCodes', 'concessionChargeCodes'],
      properties: {
        chargeDescCol: colIdx,
        chargeAmtCol: colIdx,
        rentChargeCodes: { type: 'array', items: { type: 'string' } },
        subsidyChargeCodes: { type: 'array', items: { type: 'string' } },
        employeeDiscountChargeCodes: { type: 'array', items: { type: 'string' } },
        concessionChargeCodes: { type: 'array', items: { type: 'string' } },
      },
    },
    chargeColumns: {
      type: 'array',
      description: 'For row layouts whose CHARGE CODES ARE COLUMN HEADERS (one additive charge column per code on each unit row): every such column with its header verbatim, 0-based cell index, and kind. [] for other layouts.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['header', 'index', 'kind'],
        properties: {
          header: { type: 'string' },
          index: { type: 'number' },
          kind: { type: 'string', enum: ['rent', 'subsidy', 'employee_discount', 'concession', 'fee'] },
        },
      },
    },
    chargeTotalColumn: { ...colIdx, description: 'Cell index of the per-row total-charges column ("Total Charged"/"Total Billing") summing the charge columns, or -1 when absent' },
    skipPatterns: { type: 'array', items: { type: 'string' } },
    stopMarkers: { type: 'array', items: { type: 'string' } },
    statedTotalUnits: numOrNull,
    statedSummary: {
      type: 'object',
      additionalProperties: false,
      required: ['totalMonthlyRent', 'totalMarketRent', 'totalSqft', 'occupancyRate', 'occupiedUnits', 'vacantUnits'],
      properties: {
        totalMonthlyRent: numOrNull, totalMarketRent: numOrNull, totalSqft: numOrNull,
        occupancyRate: numOrNull, occupiedUnits: numOrNull, vacantUnits: numOrNull,
      },
    },
    extraColumns: {
      type: 'array',
      description: 'Every DATA column on unit rows NOT mapped to a field in "columns" — e.g. a rent-regulation/lease-type column (values like RS/RC/FM/Stabilized/Decontrolled), a legal/registered/preferential rent column, DHCR codes, or any other column. Give each column header text and 0-based cell index. [] if none.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['header', 'index'],
        properties: {
          header: { type: 'string' },
          index: { type: 'number' },
        },
      },
    },
  },
};

const MAPPER_PROMPT = `You are analyzing the STRUCTURE of a rent roll Excel sheet so deterministic code can extract every unit. You see the first rows, a middle sample, and the last rows (rows labeled "R<n>:", cells separated by " | "; cell indices are 0-based counting each " | "-separated cell).

IMPORTANT: header cells are often MERGED, so a header label's cell index can be SHIFTED relative to where the values sit on data rows (e.g. header "End Date" at index 19 while the dates appear at index 17). Derive EVERY column index from the DATA rows — the cells where values actually appear — and use the header row only to understand what each data column means. When header and data indices disagree, the data rows win.

Decide:
1. layout:
   - "row": one row per unit.
   - "block": each unit is a unit row followed by charge-code rows (Rent, Trash, Pet...) and usually a Total row.
   - "unsupported": anything else (multi-section sheets with different column sets, pivoted/transposed data, aggregate-only sheets, template/sample data).
2. dataStartRow: the R-number of the FIRST actual unit row.
3. columns: 0-based cell index for each field on UNIT rows (-1 if absent).
   tenantName2: when first and last names occupy TWO separate columns, map both (tenantName + tenantName2); else -1.
   If lease start and end share ONE column (e.g. "1/1/25 - 12/31/25"), give BOTH leaseStartDate and leaseEndDate that same index.
   monthlyRent for "row" layout = the actual/current lease rent column (NOT market/scheduled/budgeted rent).
   marketRent = the market/asking/scheduled rent column when one exists (-1 when absent).
   subsidyRent = a column showing the subsidy/HAP/Section-8 portion of the rent (-1 when absent).
   employeeDiscount = a column with a recurring employee/manager discount (-1 when absent).
   concession = a column with a recurring monthly concession/credit (-1 when absent).
   For "block" layout, monthlyRent is usually null (rent comes from charge rows).
4. block (for layout="row" use {chargeDescCol:-1, chargeAmtCol:-1} and [] for every code list; for layout="block"): chargeDescCol/chargeAmtCol = cell indices of charge description and amount on CHARGE rows, and rentChargeCodes = the exact charge-code strings whose amounts make up the unit's rent (e.g. ["rent"], ["rnt"], ["rent", "housing assistance rent"]). Include rent-subsidy codes; EXCLUDE fee codes (trash, pet, parking, amenity) and total lines.
   subsidyChargeCodes = the subset of rentChargeCodes that are subsidy/housing-assistance codes (also keep them in rentChargeCodes — monthlyRent stays the TOTAL contract rent).
   employeeDiscountChargeCodes = codes for recurring employee/manager discounts (e.g. "empl", "employee discount"); NOT in rentChargeCodes.
   concessionChargeCodes = codes for recurring monthly RENT concessions; NOT in rentChargeCodes.
   Charge codes are often cryptic abbreviations ("conc", "como", "empl", "rentcr"). Classify EVERY code that appears in the COLUMN VALUE INVENTORY below (if provided) using its name, sign, and magnitude: codes with clearly NEGATIVE sums are concessions/discounts/credits, not fees. concessionChargeCodes must contain ONLY rent concessions — exclude one-time/"other" concession codes (e.g. "coro" next to "como") and credits tied to a specific amenity (garage/carport/parking credits like "crgar", "crcarp" belong to no list).
5. chargeColumns / chargeTotalColumn: some ROW layouts put each charge code in its OWN COLUMN — the column headers ARE charge codes (a rent-charged column, subsidy/housing-assistance columns, fee columns like pet/garage/storage/utilities, cryptic PMS abbreviations or numeric codes) and each unit row carries an AMOUNT per code, usually with a per-row "Total Charged"/"Total" column summing them. The test is ADDITIVITY: these columns' amounts (with the rent) add up to the row's total-charges figure. A column of regulation/status/type CODES (text values, not amounts) is NEVER a charge column — it belongs in extraColumns. List every additive charge column in chargeColumns (header verbatim, 0-based data-row index) with a kind:
   "rent" = a component of the unit's contract rent: the base/charged-rent column AND any negative rent-adjustment column that is part of the contract rent rather than a promotional discount (e.g. a preferential-rent reduction).
   "subsidy" = a Section 8 / HAP / subsidy portion of the rent (it is part of contract rent; deterministic code reports it separately too).
   "employee_discount" / "concession" = recurring discount/concession columns that are NOT part of contract rent.
   "fee" = ancillary charges billed on top of rent (parking, storage, washer-dryer, pet, utilities, misc fee codes).
   chargeTotalColumn = the per-row total column's index (-1 when absent) — NEVER list it as a chargeColumn and NEVER map it to columns.monthlyRent. Do NOT list non-additive columns (a legal/market/registered rent column belongs in columns.marketRent or extraColumns; a tenant-share or informational column belongs in extraColumns). When the sheet has chargeColumns and NO single actual-rent column, leave columns.monthlyRent = -1 — deterministic code computes each unit's rent from the "rent"+"subsidy" columns. [] and -1 for sheets without per-code charge columns.
6. skipPatterns: lowercase substrings identifying NON-unit rows to skip when they appear in the unit-number cell or the first cells (e.g. "total", "summary", floorplan group headers).
7. stopMarkers: lowercase substrings marking where unit data ENDS (e.g. "future residents/applicants", "summary groups", "unit type occupancy", "totals"). The walker stops at the first row containing any of these. Sections AFTER the stop (future residents, applicants, summaries) must not be extracted.
8. statedTotalUnits / statedSummary: totals STATED in the document itself (often in the last rows). null when absent. If the stated rent total is annual, divide by 12. totalMonthlyRent = the ACTUAL/current RENT total — the figure matching the rent charge code alone (a "Summary of Charges by Charge Code" rent line is the best source). It is NOT a total-charges/"Lease Charges" total that adds fees (trash, pet, parking) on top of rent, and NOT market rent. A stated market/potential/scheduled rent total goes in totalMarketRent (when only one rent total is stated, decide from its column/label which of the two it is).
9. extraColumns: every DATA column on unit rows that you did NOT map to a field in "columns" above. Give each one's header text (verbatim) and 0-based cell index. This MUST include any rent-regulation / lease-type / rent-status column (values such as "RS", "RC", "FM", "MK", "Stabilized", "Rent Controlled", "Decontrolled", "SCRIE"), any legal / registered / preferential rent column, and DHCR status codes. Deterministic code copies these cells verbatim; do NOT list columns already mapped in "columns", charge-code columns, or empty/decorative columns. [] when there are none.

If unit rows in this sheet don't share one consistent column layout, or you are unsure the mapping is exact, answer layout="unsupported" — a slower full extraction will handle it. Correctness matters more than coverage.`;

function cellValue(sheet: XLSX.WorkSheet, r: number, c: number): XLSX.CellObject | undefined {
  return sheet[XLSX.utils.encode_cell({ r, c })];
}

function excelSerialToISO(serial: number): string | null {
  if (serial < 1000 || serial > 80000) return null;
  const d = new Date(Date.UTC(1899, 11, 30) + Math.round(serial) * 86400000);
  return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

function readString(cell: XLSX.CellObject | undefined): string | null {
  if (!cell || cell.v === undefined || cell.v === null) return null;
  const s = String(cell.v).trim();
  return s === '' ? null : s;
}

function readNumber(cell: XLSX.CellObject | undefined): number | null {
  if (!cell || cell.v === undefined || cell.v === null) return null;
  if (typeof cell.v === 'number') return cell.v;
  const cleaned = String(cell.v).replace(/[$,\s]/g, '').replace(/^\((.*)\)$/, '-$1');
  const n = parseFloat(cleaned);
  return isNaN(n) ? null : n;
}

function readDate(cell: XLSX.CellObject | undefined): string | null {
  if (!cell || cell.v === undefined || cell.v === null) return null;
  if (typeof cell.v === 'number') return excelSerialToISO(cell.v);
  const s = String(cell.v).trim();
  if (!s) return null;
  const mdy = s.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{2,4})$/);
  if (mdy) {
    const [, m, d, y] = mdy;
    const year = +(y.length === 2 ? (parseInt(y) > 50 ? `19${y}` : `20${y}`) : y);
    const lastDay = new Date(Date.UTC(year, +m, 0)).getUTCDate();
    const dt = new Date(Date.UTC(year, +m - 1, Math.min(+d, lastDay)));
    return isNaN(dt.getTime()) ? null : dt.toISOString().slice(0, 10);
  }
  const dt = new Date(s);
  return isNaN(dt.getTime()) ? null : dt.toISOString().slice(0, 10);
}

/** Read a date; when part='start'/'end', the cell holds a range like "1/1/25 - 12/31/25". */
function readDateAt(sheet: XLSX.WorkSheet, r: number, c: number, part: 'start' | 'end' | null): string | null {
  const cell = cellValue(sheet, r, c);
  if (part === null) return readDate(cell);
  const raw = readString(cell);
  if (!raw) return readDate(cell);
  const pieces = raw.split(/\s*(?:-|–|to|through)\s*/i).filter(Boolean);
  if (pieces.length >= 2) {
    return readDate({ t: 's', v: part === 'start' ? pieces[0] : pieces[pieces.length - 1] } as XLSX.CellObject);
  }
  return readDate(cell);
}

function rowText(sheet: XLSX.WorkSheet, r: number, maxCol: number): string {
  const parts: string[] = [];
  for (let c = 0; c <= maxCol; c++) {
    const v = readString(cellValue(sheet, r, c));
    if (v) parts.push(v);
  }
  return parts.join(' ').toLowerCase();
}

function matchesAny(text: string, patterns: string[]): boolean {
  return patterns.some(p => p && text.includes(p.toLowerCase()));
}

/**
 * Deterministic category heuristic for the fast path (the full-AI path
 * classifies per-row). Uses the unit id and type text the walker already reads.
 * Factual only — NOT a regulatory status. Ancillary income lines
 * (parking/antenna/laundry/storage/signage) get includeInUnitCount=false.
 */
function classifyCategory(
  unitNumber: string,
  unitType: string | null,
): { category: 'residential' | 'commercial' | 'non_unit_income'; includeInUnitCount: boolean } {
  const s = `${unitNumber} ${unitType ?? ''}`.toLowerCase();
  if (/\b(parking|garage|carport|antenna|cell\s*tower|rooftop|laundry|storage|locker|billboard|signage|sign)\b/.test(s)) {
    return { category: 'non_unit_income', includeInUnitCount: false };
  }
  if (/\b(store|retail|office|comm|commercial|restaurant|medical|professional)\b/.test(s) || /^c\d|^cm\b|^comm/i.test(unitNumber)) {
    return { category: 'commercial', includeInUnitCount: true };
  }
  return { category: 'residential', includeInUnitCount: true };
}

/**
 * Compact per-column inventory of repeated short string values (charge codes,
 * statuses) across the WHOLE sheet, with counts and — when the next column is
 * numeric — sums. The structure sample shows only first/middle/last rows, so
 * rare-but-important codes (7 "como" concession rows in a 2,090-row sheet)
 * never reach the mapper without this. Sign and magnitude are what let the
 * mapper classify cryptic codes: a code summing to -10,784 is a concession.
 */
export function columnValueInventory(sheet: XLSX.WorkSheet): string {
  const ref = sheet['!ref'];
  if (!ref) return '';
  const range = XLSX.utils.decode_range(ref);
  const maxCol = Math.min(range.e.c, 40);
  const lines: string[] = [];
  for (let c = range.s.c; c <= maxCol; c++) {
    const counts = new Map<string, { n: number; sum: number; sumN: number }>();
    let occurrences = 0;
    for (let r = range.s.r; r <= range.e.r; r++) {
      const cell = cellValue(sheet, r, c);
      if (!cell || cell.t !== 's') continue;
      const v = String(cell.v).trim();
      if (!v || v.length > 25 || /\d{3,}/.test(v)) continue; // skip long text and id-like values
      occurrences++;
      const e = counts.get(v) ?? { n: 0, sum: 0, sumN: 0 };
      e.n++;
      const amt = readNumber(cellValue(sheet, r, c + 1));
      if (amt !== null) { e.sum += amt; e.sumN++; }
      counts.set(v, e);
    }
    // Only code-like columns: few distinct values, each repeated.
    if (counts.size < 2 || counts.size > 25 || occurrences < 10) continue;
    const parts = [...counts.entries()]
      .sort((a, b) => b[1].n - a[1].n)
      .map(([v, e]) => {
        const sum = e.sumN >= e.n * 0.6 ? `, next-col sum ${Math.round(e.sum * 100) / 100}` : '';
        return `"${v}" (${e.n} rows${sum})`;
      });
    lines.push(`Cell index ${c}: ${parts.join(', ')}`);
  }
  if (lines.length === 0) return '';
  return `\n\nCOLUMN VALUE INVENTORY — every repeated short text value per cell index across ALL rows of the sheet (the row sample above omits rows; rare charge codes appear here even when no sampled row shows them). Use it ONLY to classify charge codes. The counts/sums are computed by code, NOT stated by the document — statedTotalUnits/statedSummary must come from totals printed in the document rows, never from these sums (a "Total" code's sum here is a charges total, not the stated rent total):\n${lines.join('\n')}`;
}

/** Ask the mapper model for the sheet structure. */
export async function mapSheetStructure(
  sampleText: string
): Promise<{ structure: SheetStructure; usage: AIUsage }> {
  const { data, usage } = await extractStructured<SheetStructure>({
    model: MODELS.fast,
    content: [{ type: 'text', text: `${MAPPER_PROMPT}\n\n${sampleText}` }],
    schema: STRUCTURE_SCHEMA,
    // Adaptive thinking shares this budget, and the mapper's reasoning load
    // scales with the charge-code inventory + extraColumns enumeration; 16K
    // truncated on charge-heavy institutional sheets (which then lose the
    // fast path entirely). Generous cap: every observed overflow was a
    // legitimately hard sheet, not a runaway.
    maxTokens: 60000,
  });
  // Normalize -1 sentinels (schema union-count workaround) back to null.
  const norm = (v: number | null) => (v === null || v < 0 ? null : v);
  for (const k of Object.keys(data.columns) as (keyof ColumnMap)[]) {
    data.columns[k] = norm(data.columns[k]);
  }
  if (data.block) {
    data.block.chargeDescCol = norm(data.block.chargeDescCol);
    data.block.chargeAmtCol = norm(data.block.chargeAmtCol);
  }
  data.chargeTotalColumn = norm(data.chargeTotalColumn ?? null);
  data.chargeColumns = (data.chargeColumns ?? []).filter(
    c => c && typeof c.index === 'number' && c.index >= 0 && !!c.header
  );
  return { structure: data, usage };
}

// Charge-column kind -> downstream charge category. 'fee' stays unmapped so
// the keyword prior + per-document AI classifier decide (garage -> parking, …).
const KIND_CATEGORY: Partial<Record<ChargeColumn['kind'], ChargeCategory>> = {
  rent: 'base_rent',
  subsidy: 'subsidy',
  employee_discount: 'concession',
  concession: 'concession',
};

/** Walk the sheet deterministically using the structure. */
export function applyStructure(
  sheet: XLSX.WorkSheet,
  s: SheetStructure,
  dedupe: 'applicant-over-vacant' | 'current-occupancy' = 'applicant-over-vacant'
): FastPathResult | null {
  if (s.layout === 'unsupported' || s.columns.unitNumber === null) return null;
  if (s.layout === 'block' && (!s.block || s.block.chargeDescCol === null || s.block.chargeAmtCol === null || s.block.rentChargeCodes.length === 0)) {
    return null;
  }

  const ref = sheet['!ref'];
  if (!ref) return null;
  const range = XLSX.utils.decode_range(ref);
  const maxCol = Math.min(range.e.c, 80);
  // sheetToGrid renders the grid from the sheet's first populated column, so the
  // mapper's column indices are grid-relative while cellValue() addresses
  // absolute sheet columns. On a sheet whose used range starts past column A
  // (leading blank spacer columns are common in report exports) every lookup
  // would land originCol columns to the left and read blanks — the walk yields
  // zero units and the sheet falls back to the AI ladder. Rows need no such
  // shift: the grid labels them absolutely ("R<n>").
  const originCol = range.s.c;
  const toSheetCol = (i: number | null): number | null => (i === null ? null : i + originCol);
  const skip = s.skipPatterns.map(p => p.toLowerCase()).filter(Boolean);
  const stops = s.stopMarkers.map(p => p.toLowerCase()).filter(Boolean);
  const rentCodes = new Set((s.block?.rentChargeCodes ?? []).map(c => c.toLowerCase().trim()));
  const subsidyCodes = new Set((s.block?.subsidyChargeCodes ?? []).map(c => c.toLowerCase().trim()));
  const discountCodes = new Set((s.block?.employeeDiscountChargeCodes ?? []).map(c => c.toLowerCase().trim()));
  const concessionCodes = new Set((s.block?.concessionChargeCodes ?? []).map(c => c.toLowerCase().trim()));

  const units: ExtractedUnit[] = [];
  const cols: typeof s.columns = { ...s.columns };
  for (const key of Object.keys(cols) as (keyof typeof cols)[]) cols[key] = toSheetCol(cols[key]);
  const chargeDescCol = toSheetCol(s.block?.chargeDescCol ?? null);
  const chargeAmtCol = toSheetCol(s.block?.chargeAmtCol ?? null);
  // Per-charge-code columns (row layout only): headers are the charge codes.
  // Guard against the classic header collision ("RC" is a rent CHARGE column in
  // some documents and a Rent-Controlled STATUS code in others): a charge
  // column must actually hold amounts. A mapper-listed column whose populated
  // data cells are mostly non-numeric text is a status/code column — misfiling
  // it here would not corrupt amounts (text reads as null) but WOULD consume
  // its index and silently drop the verbatim values from sourceColumns. Such
  // columns are demoted to extraColumns instead.
  const looksNumericColumn = (sheetCol: number): boolean => {
    let filled = 0;
    let numeric = 0;
    for (let rr = Math.max(range.s.r, s.dataStartRow - 1); rr <= range.e.r; rr++) {
      if (readString(cellValue(sheet, rr, sheetCol)) === null) continue;
      filled++;
      if (readNumber(cellValue(sheet, rr, sheetCol)) !== null) numeric++;
    }
    return filled === 0 || numeric >= filled * 0.5;
  };
  const mappedChargeCols =
    s.layout === 'row'
      ? (s.chargeColumns ?? []).map(cc => ({ ...cc, index: cc.index + originCol }))
      : [];
  const chargeCols: ChargeColumn[] = mappedChargeCols.filter(cc => looksNumericColumn(cc.index));
  const demotedChargeCols = mappedChargeCols.filter(cc => !chargeCols.includes(cc));
  const chargeTotalCol = s.layout === 'row' ? toSheetCol(s.chargeTotalColumn ?? null) : null;
  // The per-row printed totals + grand total anchor only exists when both the
  // charge columns and the total column are mapped.
  const auditCharges = chargeCols.length > 0 && chargeTotalCol !== null;

  // Columns to capture verbatim into sourceColumns: the mapper's extraColumns,
  // minus any index already mapped to a first-class field (guard against the
  // mapper double-listing a mapped column).
  const usedIdx = new Set<number>();
  for (const v of Object.values(cols)) if (v !== null) usedIdx.add(v);
  for (const v of [chargeDescCol, chargeAmtCol, chargeTotalCol]) if (v !== null) usedIdx.add(v);
  for (const cc of chargeCols) usedIdx.add(cc.index);
  const extraCols = (s.extraColumns ?? [])
    .filter(ec => ec && typeof ec.index === 'number' && ec.index >= 0 && ec.header)
    .map(ec => ({ ...ec, index: ec.index + originCol }))
    .filter(ec => !usedIdx.has(ec.index));
  // Demoted charge columns (text-valued, so status/code columns the mapper
  // misfiled — see looksNumericColumn) are preserved verbatim like any other
  // unmapped column, unless the mapper also listed them in extraColumns.
  for (const cc of demotedChargeCols) {
    if (!usedIdx.has(cc.index) && !extraCols.some(ec => ec.index === cc.index)) {
      extraCols.push({ header: cc.header, index: cc.index });
    }
  }

  // A block-internal charge "Total"/"Charge Total:" line. Mapper samples
  // sometimes emit "total" as a stopMarker (the prompt even suggests "totals"
  // for summary sections) — but in a block layout EVERY unit's block ends with
  // such a line, so obeying it would end the walk after the first unit
  // (observed: a 142-unit sheet walked as 1 unit, rent sum 1,600). Stop
  // markers therefore never break on these rows. Multi-word grand totals
  // ("<property name> Total:") don't match CHARGE_TOTAL_LINE and still stop
  // the walk.
  const isBlockTotalRow = (rr: number): boolean => {
    if (s.layout !== 'block' || chargeDescCol === null || chargeAmtCol === null) return false;
    const d = readString(cellValue(sheet, rr, chargeDescCol));
    return !!d && CHARGE_TOTAL_LINE.test(d.trim()) && readNumber(cellValue(sheet, rr, chargeAmtCol)) !== null;
  };
  const isStopRow = (rr: number, text: string): boolean =>
    matchesAny(text, stops) && !isBlockTotalRow(rr);

  const isUnitRow = (r: number): string | null => {
    const unitVal = readString(cellValue(sheet, r, cols.unitNumber!));
    if (!unitVal || unitVal.length > 30) return null;
    const lower = unitVal.toLowerCase();
    if (matchesAny(lower, skip) || matchesAny(lower, stops)) return null;
    // Require corroboration for ids without digits (e.g. "STORE") so stray
    // text rows don't become units.
    if (!/\d/.test(unitVal)) {
      if (/^(store|retail|office|comm|laundry|cell|antenna|garage|bsmt|grnd|wlkin|super|penthouse|ph)\b/i.test(unitVal)) {
        return unitVal;
      }
      const hasContext =
        (cols.status !== null && readString(cellValue(sheet, r, cols.status))) ||
        (cols.tenantName !== null && readString(cellValue(sheet, r, cols.tenantName))) ||
        (cols.monthlyRent !== null && readNumber(cellValue(sheet, r, cols.monthlyRent)) !== null);
      if (!hasContext) return null;
    }
    return unitVal;
  };

  // Anchor bookkeeping for charge-column layouts: the last row that produced a
  // unit (the grand-total scan starts below it) and rows the walk REJECTED even
  // though their unit cell holds candidate text — a nonzero count means the
  // walk may have dropped units, which voids the completeness proof.
  let lastUnitRow = -1;
  let orphanRows = 0;
  for (let r = Math.max(range.s.r, s.dataStartRow - 1); r <= range.e.r; r++) {
    const joined = rowText(sheet, r, Math.min(maxCol, 12));
    if (!joined) continue;
    if (isStopRow(r, joined)) break;
    if (matchesAny(joined, skip)) continue;

    const unitNumber = isUnitRow(r);
    if (!unitNumber) {
      if (auditCharges) {
        const uv = readString(cellValue(sheet, r, cols.unitNumber!));
        const lower = (uv ?? '').toLowerCase();
        if (uv && uv.length <= 30 && !matchesAny(lower, skip) && !matchesAny(lower, stops)) orphanRows++;
      }
      continue;
    }
    lastUnitRow = r;

    // Block layout: a unit's scalar attributes (market rent, sqft, dates, type)
    // do not always sit on the row carrying the unit id. A block whose first
    // charge line is e.g. `storage` puts the `rent` line — and the market rent
    // beside it — on the row below. Rent already walks the whole block by charge
    // code; scalars read the anchor row only, so they came back null and the
    // market-rent total silently under-summed by that unit.
    //
    // So scan the block's CONTIGUOUS rows and take the first value present,
    // anchor row first. Bounded by the next unit row, a stop marker, the first
    // fully blank row (blocks are blank-separated in these exports) and a hard
    // row cap — otherwise a distant footer total could be attributed to the
    // last unit in the sheet.
    let scalarEnd = r;
    if (s.layout === 'block') {
      for (let cr = r + 1; cr <= Math.min(range.e.r, r + SCALAR_SCAN_LIMIT); cr++) {
        if (isUnitRow(cr)) break;
        const t = rowText(sheet, cr, Math.min(maxCol, 12));
        if (!t || isStopRow(cr, t)) break;
        scalarEnd = cr;
      }
    }
    /** First row in this unit's block carrying a value in `col` (anchor row wins). */
    const scalarRow = (col: number | null): number => {
      if (col === null || scalarEnd === r) return r;
      // Never scan the charge columns or the unit-id column: that would pull the
      // NEXT charge line's description/amount into a scalar field.
      if (col === chargeDescCol || col === chargeAmtCol || col === cols.unitNumber) return r;
      for (let cr = r; cr <= scalarEnd; cr++) {
        const v = cellValue(sheet, cr, col);
        if (v !== undefined && v !== null && String(v).trim() !== '') return cr;
      }
      return r;
    };

    const rawStatus = cols.status !== null ? readString(cellValue(sheet, scalarRow(cols.status), cols.status)) : null;
    let tenantName = cols.tenantName !== null ? readString(cellValue(sheet, scalarRow(cols.tenantName), cols.tenantName)) : null;
    if (cols.tenantName2 !== null) {
      const second = readString(cellValue(sheet, scalarRow(cols.tenantName2), cols.tenantName2));
      if (second) tenantName = tenantName ? `${tenantName} ${second}` : second;
    }

    let monthlyRent: number | null = null;
    let subsidyRent: number | null = null;
    let employeeDiscount: number | null = null;
    let concession: number | null = null;
    // Block layouts: every charge line captured verbatim (the unit's full
    // income picture), plus the block's printed "Charge Total" as a
    // completeness anchor for chargeTotalIssue().
    let charges: { code: string; amount: number; category?: ChargeCategory }[] | undefined;
    let blockChargeTotal: number | null = null;
    const cents = (n: number) => Math.round(n * 100) / 100;
    if (s.layout === 'row') {
      monthlyRent = cols.monthlyRent !== null ? readNumber(cellValue(sheet, r, cols.monthlyRent)) : null;
      subsidyRent = cols.subsidyRent !== null ? readNumber(cellValue(sheet, r, cols.subsidyRent)) : null;
      employeeDiscount = cols.employeeDiscount !== null ? readNumber(cellValue(sheet, r, cols.employeeDiscount)) : null;
      concession = cols.concession !== null ? readNumber(cellValue(sheet, r, cols.concession)) : null;
      if (chargeCols.length > 0) {
        // Charge-code columns: every nonzero cell is a charge line (header =
        // code, verbatim). Zero/dash cells are the grid's "no such charge" and
        // would only be noise. Rent-component columns also sum into the scalar
        // fields, mirroring the block walker: subsidy is part of contract rent.
        const chargeLines: { code: string; amount: number; category?: ChargeCategory }[] = [];
        const sums = { rent: 0, subsidy: 0, discount: 0, concession: 0 };
        const saw = { rent: false, subsidy: false, discount: false, concession: false };
        for (const cc of chargeCols) {
          const amt = readNumber(cellValue(sheet, r, cc.index));
          if (amt === null) continue;
          if (amt !== 0) {
            const category = KIND_CATEGORY[cc.kind];
            chargeLines.push({ code: cc.header.trim(), amount: amt, ...(category ? { category } : {}) });
          }
          // The grid fills every cell (a dash reads as numeric 0), so a zero in
          // a subsidy/discount/concession column means "none" — only nonzero
          // amounts latch those fields, mirroring the block walker where the
          // flag fires only when the charge row exists. Rent keeps latching on
          // zero: an explicit $0 rent (super/employee unit) is a real value.
          switch (cc.kind) {
            case 'rent': sums.rent += amt; saw.rent = true; break;
            case 'subsidy':
              sums.rent += amt; saw.rent = true;
              if (amt !== 0) { sums.subsidy += amt; saw.subsidy = true; }
              break;
            case 'employee_discount':
              if (amt !== 0) { sums.discount += amt; saw.discount = true; }
              break;
            case 'concession':
              if (amt !== 0) { sums.concession += amt; saw.concession = true; }
              break;
          }
        }
        if (chargeLines.length > 0) charges = chargeLines;
        if (chargeTotalCol !== null) blockChargeTotal = readNumber(cellValue(sheet, r, chargeTotalCol));
        // A mapped scalar column always wins; the column sums fill the gaps.
        if (monthlyRent === null && saw.rent) monthlyRent = cents(sums.rent);
        if (subsidyRent === null && saw.subsidy) subsidyRent = cents(sums.subsidy);
        if (employeeDiscount === null && saw.discount) employeeDiscount = cents(sums.discount);
        if (concession === null && saw.concession) concession = cents(sums.concession);
        // No-breakdown row: every charge column blank/zero but the printed row
        // total is nonzero (a commercial unit whose rent is typed only into the
        // total column). The total is the row's only rent figure — use it.
        if (cols.monthlyRent === null && !charges &&
            (monthlyRent === null || monthlyRent === 0) &&
            blockChargeTotal !== null && blockChargeTotal !== 0) {
          monthlyRent = blockChargeTotal;
        }
        // Dash cells in these grids read as literal zeros, including through a
        // scalar-mapped column (a subsidy column that IS one of the charge
        // columns). A zero subsidy/discount/concession means "none" — null,
        // matching the AI path's "null when none" field contract.
        if (subsidyRent === 0) subsidyRent = null;
        if (employeeDiscount === 0) employeeDiscount = null;
        if (concession === 0) concession = null;
      }
    } else {
      // block: scan charge rows (including the unit row itself) until the next
      // unit row or a stop/skip boundary; bucket amounts by charge-code category.
      // Subsidy codes are a subset of rent codes (monthlyRent = total contract
      // rent), while discounts/concessions are separate adjustments.
      const sums = { rent: 0, subsidy: 0, discount: 0, concession: 0 };
      const saw = { rent: false, subsidy: false, discount: false, concession: false };
      const chargeLines: { code: string; amount: number }[] = [];
      for (let cr = r; cr <= range.e.r; cr++) {
        if (cr > r) {
          if (isUnitRow(cr)) break;
          const t = rowText(sheet, cr, Math.min(maxCol, 12));
          if (isStopRow(cr, t)) break;
        }
        const desc = readString(cellValue(sheet, cr, chargeDescCol!));
        const amt = readNumber(cellValue(sheet, cr, chargeAmtCol!));
        if (!desc || amt === null) continue;
        if (CHARGE_TOTAL_LINE.test(desc.trim())) {
          if (blockChargeTotal === null) blockChargeTotal = amt;
        } else {
          chargeLines.push({ code: desc.trim(), amount: amt });
        }
        // Bucketing is independent of the capture above so the rent math stays
        // byte-identical to the pre-charges walker.
        const code = desc.toLowerCase().trim();
        if (rentCodes.has(code)) { sums.rent += amt; saw.rent = true; }
        if (subsidyCodes.has(code)) { sums.subsidy += amt; saw.subsidy = true; }
        if (discountCodes.has(code)) { sums.discount += amt; saw.discount = true; }
        if (concessionCodes.has(code)) { sums.concession += amt; saw.concession = true; }
      }
      if (chargeLines.length > 0) charges = chargeLines;
      monthlyRent = saw.rent ? cents(sums.rent) : null;
      subsidyRent = saw.subsidy ? cents(sums.subsidy) : null;
      employeeDiscount = saw.discount ? cents(sums.discount) : null;
      concession = saw.concession ? cents(sums.concession) : null;
    }

    // No status column: vacancy is often encoded as a placeholder "tenant"
    // (VACANT / MODEL / ADMIN) in the resident column.
    let status = rawStatus ? normalizeStatus(rawStatus) : null;
    let tenant = tenantName;
    if (status === null) {
      const t = (tenantName ?? '').toLowerCase();
      if (/^vacant/.test(t)) { status = 'vacant'; tenant = null; }
      else if (/^model/.test(t)) { status = 'model'; tenant = null; }
      else if (/^(admin|down|office|maint)/.test(t)) { status = 'down'; tenant = null; }
      else if (/^(future|applicant|pending)/.test(t)) { status = 'applicant'; tenant = null; }
      else status = tenant ? 'occupied' : 'vacant';
    }

    const unitType = cols.unitType !== null ? readString(cellValue(sheet, scalarRow(cols.unitType), cols.unitType)) : null;
    const { category, includeInUnitCount } = classifyCategory(unitNumber, unitType);
    const sourceColumns = extraCols
      .map(ec => ({ header: ec.header, value: readString(cellValue(sheet, scalarRow(ec.index), ec.index)) }))
      .filter((x): x is { header: string; value: string } => x.value !== null);

    units.push({
      unitNumber,
      status,
      category,
      includeInUnitCount,
      sourceColumns,
      ...(charges ? { charges } : {}),
      ...(blockChargeTotal !== null ? { blockChargeTotal } : {}),
      monthlyRent,
      marketRent: cols.marketRent !== null ? readNumber(cellValue(sheet, scalarRow(cols.marketRent), cols.marketRent)) : null,
      subsidyRent,
      employeeDiscount,
      concession,
      tenantName: tenant,
      unitSqft: cols.unitSqft !== null ? readNumber(cellValue(sheet, scalarRow(cols.unitSqft), cols.unitSqft)) : null,
      unitType,
      leaseStatus: rawStatus,
      moveInDate: cols.moveInDate !== null ? readDate(cellValue(sheet, scalarRow(cols.moveInDate), cols.moveInDate)) : null,
      moveOutDate: cols.moveOutDate !== null ? readDate(cellValue(sheet, scalarRow(cols.moveOutDate), cols.moveOutDate)) : null,
      leaseStartDate: cols.leaseStartDate !== null ? readDateAt(sheet, scalarRow(cols.leaseStartDate), cols.leaseStartDate, cols.leaseStartDate === cols.leaseEndDate ? 'start' : null) : null,
      leaseEndDate: cols.leaseEndDate !== null ? readDateAt(sheet, scalarRow(cols.leaseEndDate), cols.leaseEndDate, cols.leaseStartDate === cols.leaseEndDate ? 'end' : null) : null,
    });
  }

  // Dedupe repeated unit numbers (applicant/renewal duplicate rows): keep the
  // higher-priority occupancy row. Documents disagree on the convention —
  // some totals count a vacant-leased unit's APPLICANT row (future rent),
  // others count the current VACANT row (rent 0, per "occupied and vacant
  // units only" footnotes). The caller tries both and lets the document's own
  // stated totals arbitrate.
  const priority: Record<string, number> =
    dedupe === 'applicant-over-vacant'
      ? { occupied: 5, notice: 4, applicant: 3, model: 2, down: 2, vacant: 1 }
      : { occupied: 5, notice: 4, vacant: 3, model: 2, down: 2, applicant: 1 };
  const byUnit = new Map<string, ExtractedUnit>();
  for (const u of units) {
    const key = u.unitNumber.toUpperCase();
    const existing = byUnit.get(key);
    if (!existing || (priority[u.status] ?? 0) > (priority[existing.status] ?? 0)) {
      byUnit.set(key, u);
    }
  }

  // Charge-column anchor: computed over the PRE-dedupe unit list because the
  // document's grand total sums every printed row, duplicates included.
  let chargeColumnAnchor: ChargeColumnAnchor | undefined;
  if (auditCharges && units.length > 0) {
    const withTotals = units.filter(u => u.blockChargeTotal !== null && u.blockChargeTotal !== undefined);
    const reconciled = withTotals.filter(
      u => Math.abs((u.charges ?? []).reduce((a, c) => a + c.amount, 0) - u.blockChargeTotal!) <= 0.02
    );
    const minRowTotal = withTotals.reduce(
      (m, u) => (u.blockChargeTotal! > 0 ? Math.min(m, u.blockChargeTotal!) : m),
      Infinity
    );
    // The column's printed grand total: first numeric cell in the total column
    // below the last unit row. A unit-like row in between means a later data
    // section the walk did not extract — no cell past it may serve as anchor.
    let statedGrandTotal: number | null = null;
    for (let gr = lastUnitRow + 1; gr <= range.e.r; gr++) {
      if (isUnitRow(gr)) break;
      const v = readNumber(cellValue(sheet, gr, chargeTotalCol!));
      if (v !== null) { statedGrandTotal = v; break; }
    }
    chargeColumnAnchor = {
      rowsWithTotals: withTotals.length,
      rowsReconciled: reconciled.length,
      minRowTotal: Number.isFinite(minRowTotal) ? minRowTotal : 0,
      walkedTotalSum: withTotals.reduce((a, u) => a + u.blockChargeTotal!, 0),
      statedGrandTotal,
      orphanRows,
    };
  }

  return {
    propertyName: null,
    statedTotalUnits: s.statedTotalUnits ?? null,
    statedSummary: s.statedSummary ?? {
      totalMonthlyRent: null, totalMarketRent: null, totalSqft: null,
      occupancyRate: null, occupiedUnits: null, vacantUnits: null,
    },
    units: [...byUnit.values()],
    ...(chargeColumnAnchor ? { chargeColumnAnchor } : {}),
  };
}

/**
 * Try the fast path on a sheet. Returns null when the mapper deems the layout
 * unsupported or the deterministic result fails verification against the
 * document's stated totals — callers then use the full-AI ladder.
 */
/**
 * Coverage gate: count/rent verification cannot see a silently blanked column
 * (e.g. a lease-end column whose merged header cell sits at a different index
 * than its data). If the header region clearly shows a column but the walk
 * filled it for almost no units, the mapping is wrong — reject the fast result.
 * Returns the failure description, or null when coverage looks sane.
 */
function coverageIssue(result: ExtractionResult, sampleText: string): string | null {
  const head = sampleText.slice(0, 8000).toLowerCase();
  const occ = result.units.filter(u => u.status === 'occupied' || u.status === 'notice');
  const fill = (arr: typeof result.units, f: keyof ExtractedUnit) =>
    arr.length === 0 ? 1 : arr.filter(u => u[f] !== null && u[f] !== undefined && u[f] !== '').length / arr.length;
  // moveOutDate is excluded: it is legitimately near-empty on healthy rolls.
  const checks: { field: keyof ExtractedUnit; pattern: RegExp; pool: typeof result.units }[] = [
    { field: 'leaseStartDate', pattern: /(lease\s*(start|from|begin)|lease\s*dates)/, pool: occ },
    { field: 'leaseEndDate', pattern: /(lease\s*(end|to|exp)|expir|end\s*date)/, pool: occ },
    { field: 'moveInDate', pattern: /move[\s-]*in/, pool: occ },
    { field: 'unitSqft', pattern: /(sq\.?\s*ft|sqft|square\s*(feet|footage)|\bsf\b)/, pool: result.units },
    { field: 'unitType', pattern: /(unit\s*type|floor\s*plan|floorplan|bd\/ba|bed|type:)/, pool: result.units },
  ];
  for (const c of checks) {
    if (c.pool.length < 10) continue; // too few rows to judge fill rates
    // A correctly-mapped advertised column is essentially never this sparse;
    // a false trip merely demotes the file to the slower AI ladder.
    if (c.pattern.test(head) && fill(c.pool, c.field) < 0.25) {
      return `the header shows a ${c.field} column but the deterministic read filled it for under 25% of ${c.pool.length} units — the column index is likely wrong or misaligned (merged header cells)`;
    }
  }
  return null;
}

/**
 * Charge-capture integrity gate: in a block layout, the charge lines the walk
 * captured for a unit must add up to the block's own printed "Charge Total"
 * line. A widespread mismatch means charge rows are being missed or the
 * charge columns are misread — per-unit anchors the stated-totals verification
 * cannot see. Returns the failure description, or null when totals reconcile
 * (or the document prints no per-block totals to check against).
 */
function chargeTotalIssue(result: FastPathResult): string | null {
  const withTotals = result.units.filter(u => u.blockChargeTotal !== null && u.blockChargeTotal !== undefined);
  if (withTotals.length < 10) return null; // too few printed totals to judge
  const bad = withTotals.filter(u => {
    const sum = (u.charges ?? []).reduce((a, c) => a + c.amount, 0);
    return Math.abs(sum - u.blockChargeTotal!) > 0.02;
  });
  // Charge-COLUMN layouts tolerate more per-row slack than block layouts: real
  // sheets carry rows whose printed total has no column breakdown (a STORE's
  // rent typed only into the total) or disagrees with it (a hand-edited total),
  // and the grand-total reconciliation in provenComplete() already proves the
  // captured row totals sum to what the document itself prints. 10% matches
  // the anchor's own per-row bar; a systematically wrong column mapping fails
  // both immediately.
  const allowedFraction = result.chargeColumnAnchor ? 0.1 : 0.02;
  if (bad.length > Math.max(1, withTotals.length * allowedFraction)) {
    return `the captured charge lines do not add up to the block's printed charge total for ${bad.length} of ${withTotals.length} units (e.g. unit ${bad[0].unitNumber}) — charge rows are being missed or the charge columns are misread`;
  }
  return null;
}

/**
 * What the fast path is allowed to accept as PROOF that the walk read every unit.
 *
 * A stated unit count is the cleanest anchor, but plenty of real exports never
 * print one (Yardi "Rent Roll with Lease Charges" states only money totals). A
 * stated MARKET-rent total can be just as strong, and specifically covers the
 * hole a rent total cannot: vacant units carry a market rent even at $0 actual
 * rent, so a dropped vacant moves the market sum.
 *
 * To be proof rather than a coincidence, the market anchor must satisfy all of:
 *   - every unit carries a market rent (fill = 100%) — otherwise a missing unit
 *     could contribute nothing to the sum and hide,
 *   - the walked sum matches the stated total within a HAIRLINE tolerance
 *     (max($1, 0.02%)) — these columns are additive and should agree exactly;
 *     the 0.5% band used for ordinary verification is ~2 units of slack on a
 *     $1M roll,
 *   - the smallest unit market rent EXCEEDS that tolerance, which is what makes
 *     the match dispositive: no single unit can be missing without breaking it.
 * Plus a second stated money total must exist (a lone anchor is one mapper
 * mistake away from self-agreement).
 *
 * The rent total deliberately does NOT get the hairline treatment: a stated
 * "rent" total is often a total-CHARGES figure (misc income, storage, SCRIE/DRIE
 * credits) that legitimately differs from the base-rent sum, which is why
 * verifyAgainstStated tolerates 0.5% there. It corroborates; it never proves.
 */
function provenComplete(r: FastPathResult): { ok: boolean; basis: string; detail: string } {
  if (r.statedTotalUnits !== null) {
    return { ok: true, basis: `the stated unit count (${r.statedTotalUnits})`, detail: '' };
  }

  const statedMarket = r.statedSummary?.totalMarketRent ?? null;
  const statedRent = r.statedSummary?.totalMonthlyRent ?? null;
  const parts: string[] = [];
  if (statedMarket === null || statedMarket <= 0) {
    parts.push('no stated market-rent total');
  } else {
    const withMarket = r.units.filter(u => u.marketRent !== null && u.marketRent !== undefined);
    const sum = withMarket.reduce((s, u) => s + (u.marketRent ?? 0), 0);
    const tol = Math.max(1, statedMarket * 0.0002);
    const min = withMarket.reduce((m, u) => Math.min(m, u.marketRent ?? 0), Infinity);
    if (withMarket.length < r.units.length) {
      parts.push(
        `${r.units.length - withMarket.length} of ${r.units.length} units have no market rent, so the market total cannot prove none are missing`
      );
    } else if (Math.abs(sum - statedMarket) > tol) {
      parts.push(
        `stated market rent ${statedMarket.toFixed(2)} vs walked ${sum.toFixed(2)} (off ${Math.abs(sum - statedMarket).toFixed(2)}, tolerance ${tol.toFixed(2)})`
      );
    } else if (!(min > tol)) {
      parts.push(
        `the market total reconciles but the smallest unit market rent (${min.toFixed(2)}) is within tolerance, so a missing unit could hide inside it`
      );
    } else if (statedRent === null || statedRent <= 0) {
      // No stated rent total to corroborate with — on documents whose only
      // rent-ish total is a total-charges figure, a careful mapper sample
      // correctly declines to report it as totalMonthlyRent (the prompt
      // forbids exactly that), which used to strand a perfect walk here. The
      // per-block printed "Charge Total" lines are document-stated anchors
      // too: when nearly every unit carries one and the walked charge lines
      // reproduce it to the cent, that is a stronger second anchor than any
      // single stated figure — and it is independent of the mapper's
      // stated-summary reading.
      const withTotals = r.units.filter(u => u.blockChargeTotal !== null && u.blockChargeTotal !== undefined);
      const matching = withTotals.filter(u =>
        Math.abs((u.charges ?? []).reduce((a, c) => a + c.amount, 0) - u.blockChargeTotal!) <= 0.02
      );
      if (withTotals.length >= 10 && matching.length >= r.units.length * 0.9) {
        return {
          ok: true,
          basis: `the stated market-rent total (${statedMarket.toFixed(2)} = walked ${sum.toFixed(2)}, every unit priced, smallest ${min.toFixed(2)} > ${tol.toFixed(2)} tolerance), corroborated by ${matching.length} per-block charge totals reconciling to the cent`,
          detail: '',
        };
      }
      parts.push('the market total reconciles exactly but it is the only stated money total — no second anchor to corroborate it');
    } else {
      return {
        ok: true,
        basis: `the stated market-rent total (${statedMarket.toFixed(2)} = walked ${sum.toFixed(2)}, every unit priced, smallest ${min.toFixed(2)} > ${tol.toFixed(2)} tolerance), corroborated by the stated rent total`,
        detail: '',
      };
    }
  }

  // Charge-column documents: even when no summary totals are stated, the sheet
  // often prints a per-row "Total Charged" for every unit AND a grand total at
  // the bottom of that column. Those are dozens of independent document-stated
  // anchors: each row total must equal the captured charge columns to the cent
  // (proving the column mapping), their sum must equal the printed grand total
  // within a hairline (proving no charged row was dropped), and the walk must
  // have left no unit-like row behind (covering vacants, which carry no total).
  const a = r.chargeColumnAnchor;
  if (a) {
    const stated = a.statedGrandTotal;
    if (stated === null || stated <= 0) {
      parts.push('no printed grand total found under the per-row charge-total column');
    } else if (a.rowsWithTotals < 10) {
      parts.push(`only ${a.rowsWithTotals} units carry a printed per-row charge total — too few to anchor on`);
    } else {
      const tol = Math.max(1, stated * 0.0002);
      if (Math.abs(a.walkedTotalSum - stated) > tol) {
        parts.push(
          `the charge-total column's printed grand total is ${stated.toFixed(2)} but the walked row totals sum to ${a.walkedTotalSum.toFixed(2)} (off ${Math.abs(a.walkedTotalSum - stated).toFixed(2)}, tolerance ${tol.toFixed(2)})`
        );
      } else if (!(a.minRowTotal > tol)) {
        parts.push(
          `the grand total reconciles but the smallest per-row charge total (${a.minRowTotal.toFixed(2)}) is within tolerance, so a missing charged row could hide inside it`
        );
      } else if (a.rowsReconciled < a.rowsWithTotals * 0.9) {
        parts.push(
          `only ${a.rowsReconciled} of ${a.rowsWithTotals} per-row charge totals reconcile with the captured charge columns — the charge-column mapping is suspect`
        );
      } else if (a.orphanRows > 0) {
        parts.push(
          `${a.orphanRows} row(s) in the walked region carry unit-like text but were not extracted — they could be dropped units`
        );
      } else {
        return {
          ok: true,
          basis: `the charge-total column's printed grand total (${stated.toFixed(2)} = walked ${a.walkedTotalSum.toFixed(2)}), with ${a.rowsReconciled} of ${a.rowsWithTotals} per-row charge totals reconciling to the cent and no unit-like rows left behind`,
          detail: '',
        };
      }
    }
  }
  return { ok: false, basis: '', detail: parts.join('; ') };
}

/**
 * Fee-code narrowing audit for block layouts, applied only to an ALREADY
 * ACCEPTED fast-path result.
 *
 * The hole this closes: on "Rent Roll with Lease Charges" exports whose only
 * stated money total is itself a total-charges figure, a mapper sample that
 * sweeps fee codes (storage, misc income) into rentChargeCodes reconciles with
 * that total EXACTLY, while the correct rent-only mapping is also within the
 * 0.5% band — verification cannot arbitrate, and per-unit rents silently
 * include fees (unit 05R: rent 9,995 + storage 200 reported as 10,195).
 *
 * Deterministic resolution toward the mapper contract (fees are never rent):
 * re-walk with each suspect code removed and drop the ones that behave like
 * pure add-on fees. Every guard fails closed to the accepted result:
 *   - only block layouts with a stated rent total to arbitrate against;
 *   - suspects are codes not containing "rent" and not declared subsidy codes
 *     (HAP/housing-assistance components are protected);
 *   - a code is dropped only if its removal never INCREASES any unit's rent
 *     (credits like SCRIE/DRIE exemptions stay put) and never nulls one;
 *   - the narrowed walk must change something, keep every unit, still satisfy
 *     verifyAgainstStated, and still reconcile with the stated rent total
 *     within the same tolerance verification uses.
 * The walk is pure code, so the extra passes cost no AI calls.
 */
export function narrowFeeChargeCodes(
  sheet: XLSX.WorkSheet,
  s: SheetStructure,
  convention: 'applicant-over-vacant' | 'current-occupancy',
  accepted: ExtractionResult,
  external?: PreviewData | null
): { result: ExtractionResult; dropped: string[] } | null {
  if (s.layout !== 'block' || !s.block) return null;
  const statedRent = accepted.statedSummary?.totalMonthlyRent ?? null;
  if (statedRent === null || statedRent <= 0) return null;

  const subsidy = new Set(s.block.subsidyChargeCodes.map(c => c.toLowerCase().trim()));
  const suspects = s.block.rentChargeCodes.filter(c => {
    const k = c.toLowerCase().trim();
    return !k.includes('rent') && !subsidy.has(k);
  });
  if (suspects.length === 0) return null;

  const withCodes = (codes: string[]): ExtractionResult | null =>
    applyStructure(sheet, { ...s, block: { ...s.block!, rentChargeCodes: codes } }, convention);

  // true when `trial` matches `accepted` unit-for-unit with only monotone
  // rent decreases (a pure add-on fee was removed, never a credit or a
  // unit's sole rent source).
  const monotoneDecrease = (trial: ExtractionResult): boolean => {
    if (trial.units.length !== accepted.units.length) return false;
    for (let i = 0; i < trial.units.length; i++) {
      if (trial.units[i].unitNumber !== accepted.units[i].unitNumber) return false;
      const a = accepted.units[i].monthlyRent;
      const b = trial.units[i].monthlyRent;
      if (a === null ? b !== null : b === null || b > a) return false;
    }
    return true;
  };

  const dropped = suspects.filter(code => {
    const trial = withCodes(s.block!.rentChargeCodes.filter(c => c !== code));
    return trial !== null && monotoneDecrease(trial);
  });
  if (dropped.length === 0) return null;

  const finalCodes = s.block.rentChargeCodes.filter(c => !dropped.includes(c));
  if (finalCodes.length === 0) return null;
  const narrowed = withCodes(finalCodes);
  if (!narrowed || !monotoneDecrease(narrowed)) return null;
  const changed = narrowed.units.some(
    (u, i) => (u.monthlyRent ?? 0) !== (accepted.units[i].monthlyRent ?? 0)
  );
  if (!changed) return null;

  // The narrowed read must still reconcile with the document's stated rent
  // total on its own — otherwise the "fees" were load-bearing and the original
  // mapping stands.
  const sum = narrowed.units.reduce((acc, u) => acc + (u.monthlyRent ?? 0), 0);
  if (Math.abs(sum - statedRent) > Math.max(5, statedRent * 0.005)) return null;

  if (external) applyExternalStated(narrowed, external);
  if (!verifyAgainstStated(narrowed).ok) return null;
  return { result: narrowed, dropped };
}

export async function tryFastPath(
  sheet: XLSX.WorkSheet,
  sampleText: string,
  usages: AIUsage[],
  external?: PreviewData | null
): Promise<{ result: ExtractionResult | null; reason?: string; basis?: string }> {
  try {
    let reason = '';
    const inventory = columnValueInventory(sheet);
    for (let attempt = 1; attempt <= 2; attempt++) {
      const hint = attempt > 1
        ? `\n\nNOTE: a previous structure mapping produced a walk that failed verification (${reason.slice(0, 300)}). Re-examine the layout — the usual causes are the wrong rent column (actual in-place rent vs market/scheduled rent vs total charges) or wrong skip/stop markers.`
        : '';
      // One retry on mapper-call failure: transient API errors (mid-stream
      // terminations, 529 bursts) otherwise forfeit the whole fast path — a
      // ~30s/$0.02 call standing in for 10+ ladder minutes. A second failure
      // falls through to the outer catch and the AI ladder.
      let mapped: Awaited<ReturnType<typeof mapSheetStructure>>;
      try {
        mapped = await mapSheetStructure(sampleText + inventory + hint);
      } catch (e) {
        console.warn('[excelFastPath] mapper call failed, retrying once:', e instanceof Error ? e.message.slice(0, 120) : e);
        mapped = await mapSheetStructure(sampleText + inventory + hint);
      }
      const { structure, usage } = mapped;
      usages.push(usage);

      // Try both duplicate-row conventions (see applyStructure): whichever one
      // reconciles with the document's stated totals is the one this document
      // uses. The walk is pure code, so the second variant is free.
      let sawWalk = false;
      let anchored = external?.statedUnitCount != null;
      for (const convention of ['applicant-over-vacant', 'current-occupancy'] as const) {
        const result = applyStructure(sheet, structure, convention);
        if (!result || result.units.length === 0) continue;
        sawWalk = true;
        // Details+Summary exports state the unit count on a summary sheet, not
        // the detail sheet — harvested anchors let the fast path prove itself.
        if (external) applyExternalStated(result, external);
        const verification = verifyAgainstStated(result);
        // The fast path must PROVE itself against the document's own stated
        // anchors — a stated unit count, or a market-rent total strong enough to
        // stand in for one (see provenComplete).
        const proof = provenComplete(result);
        if (verification.ok && proof.ok) {
          const gap = coverageIssue(result, sampleText) ?? chargeTotalIssue(result);
          if (!gap) {
            // Charge-column documents: the printed grand total the walk was
            // proven against is a total-CHARGES figure, which the mapper
            // rightly refuses to file as a stated rent total. But when the
            // walked rents themselves reconcile with it (the charge columns
            // are all rent components), it IS the document's rent total —
            // surface it so downstream verification checks have an anchor
            // instead of skipping everything.
            const anchor = result.chargeColumnAnchor;
            if (anchor?.statedGrandTotal != null && (result.statedSummary?.totalMonthlyRent ?? null) === null) {
              const rentSum = result.units.reduce((a, u) => a + (u.monthlyRent ?? 0), 0);
              if (Math.abs(rentSum - anchor.statedGrandTotal) <= Math.max(5, anchor.statedGrandTotal * 0.005)) {
                result.statedSummary.totalMonthlyRent = anchor.statedGrandTotal;
              }
            }
            // Post-acceptance audit: strip fee codes the mapper swept into
            // rentChargeCodes when the rent-only read reconciles just as well
            // (see narrowFeeChargeCodes). Falls back to the accepted result.
            const narrowed = narrowFeeChargeCodes(sheet, structure, convention, result, external);
            if (narrowed) {
              return {
                result: narrowed.result,
                basis: `${proof.basis}; excluded fee charge code(s) ${narrowed.dropped.join(', ')} from rent — the stated rent total reconciles without them`,
              };
            }
            return { result, basis: proof.basis };
          }
          reason = gap; // feeds the retry hint — a remapped attempt may fix it
          anchored = true;
          continue;
        }
        // A remap is worth trying whenever the document offers an anchor at all.
        anchored = anchored
          || result.statedTotalUnits !== null
          || (result.statedSummary?.totalMarketRent ?? null) !== null
          || result.chargeColumnAnchor?.statedGrandTotal != null;
        reason = !verification.ok
          ? (verification.issues[0] ?? 'verification failed')
          : `no stated unit count, and the stated totals do not prove the read: ${proof.detail}`;
      }
      if (!sawWalk) reason = 'layout unsupported by the deterministic walker';

      // A second mapper attempt is only worth ~1 min when the document offers
      // a unit-count anchor the walk could actually satisfy.
      if (!anchored) break;
    }
    return { result: null, reason };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn('[excelFastPath] failed, falling back to full AI:', msg);
    return { result: null, reason: `mapper error: ${msg.slice(0, 120)}` };
  }
}
