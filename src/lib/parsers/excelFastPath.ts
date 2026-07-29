import * as XLSX from 'xlsx';
import { extractStructured, MODELS, type AIUsage } from './aiClient';
import {
  applyExternalStated,
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

const numOrNull = { type: ['number', 'null'] } as const;
// Column indices use -1 as "absent" instead of null: the structured-outputs
// compiler limits schemas to 16 union-typed parameters.
const colIdx = { type: 'number', description: '0-based cell index, or -1 if this field is not present' } as const;

const STRUCTURE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['layout', 'dataStartRow', 'columns', 'block', 'skipPatterns', 'stopMarkers', 'statedTotalUnits', 'statedSummary', 'extraColumns'],
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
5. skipPatterns: lowercase substrings identifying NON-unit rows to skip when they appear in the unit-number cell or the first cells (e.g. "total", "summary", floorplan group headers).
6. stopMarkers: lowercase substrings marking where unit data ENDS (e.g. "future residents/applicants", "summary groups", "unit type occupancy", "totals"). The walker stops at the first row containing any of these. Sections AFTER the stop (future residents, applicants, summaries) must not be extracted.
7. statedTotalUnits / statedSummary: totals STATED in the document itself (often in the last rows). null when absent. If the stated rent total is annual, divide by 12. totalMonthlyRent = the ACTUAL/current RENT total — the figure matching the rent charge code alone (a "Summary of Charges by Charge Code" rent line is the best source). It is NOT a total-charges/"Lease Charges" total that adds fees (trash, pet, parking) on top of rent, and NOT market rent. A stated market/potential/scheduled rent total goes in totalMarketRent (when only one rent total is stated, decide from its column/label which of the two it is).
8. extraColumns: every DATA column on unit rows that you did NOT map to a field in "columns" above. Give each one's header text (verbatim) and 0-based cell index. This MUST include any rent-regulation / lease-type / rent-status column (values such as "RS", "RC", "FM", "MK", "Stabilized", "Rent Controlled", "Decontrolled", "SCRIE"), any legal / registered / preferential rent column, and DHCR status codes. Deterministic code copies these cells verbatim; do NOT list columns already mapped in "columns", charge-code columns, or empty/decorative columns. [] when there are none.

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
  return { structure: data, usage };
}

/** Walk the sheet deterministically using the structure. */
export function applyStructure(
  sheet: XLSX.WorkSheet,
  s: SheetStructure,
  dedupe: 'applicant-over-vacant' | 'current-occupancy' = 'applicant-over-vacant'
): ExtractionResult | null {
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

  // Columns to capture verbatim into sourceColumns: the mapper's extraColumns,
  // minus any index already mapped to a first-class field (guard against the
  // mapper double-listing a mapped column).
  const usedIdx = new Set<number>();
  for (const v of Object.values(cols)) if (v !== null) usedIdx.add(v);
  for (const v of [chargeDescCol, chargeAmtCol]) if (v !== null) usedIdx.add(v);
  const extraCols = (s.extraColumns ?? [])
    .filter(ec => ec && typeof ec.index === 'number' && ec.index >= 0 && ec.header)
    .map(ec => ({ ...ec, index: ec.index + originCol }))
    .filter(ec => !usedIdx.has(ec.index));

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

  for (let r = Math.max(range.s.r, s.dataStartRow - 1); r <= range.e.r; r++) {
    const joined = rowText(sheet, r, Math.min(maxCol, 12));
    if (!joined) continue;
    if (matchesAny(joined, stops)) break;
    if (matchesAny(joined, skip)) continue;

    const unitNumber = isUnitRow(r);
    if (!unitNumber) continue;

    const rawStatus = cols.status !== null ? readString(cellValue(sheet, r, cols.status)) : null;
    let tenantName = cols.tenantName !== null ? readString(cellValue(sheet, r, cols.tenantName)) : null;
    if (cols.tenantName2 !== null) {
      const second = readString(cellValue(sheet, r, cols.tenantName2));
      if (second) tenantName = tenantName ? `${tenantName} ${second}` : second;
    }

    let monthlyRent: number | null = null;
    let subsidyRent: number | null = null;
    let employeeDiscount: number | null = null;
    let concession: number | null = null;
    if (s.layout === 'row') {
      monthlyRent = cols.monthlyRent !== null ? readNumber(cellValue(sheet, r, cols.monthlyRent)) : null;
      subsidyRent = cols.subsidyRent !== null ? readNumber(cellValue(sheet, r, cols.subsidyRent)) : null;
      employeeDiscount = cols.employeeDiscount !== null ? readNumber(cellValue(sheet, r, cols.employeeDiscount)) : null;
      concession = cols.concession !== null ? readNumber(cellValue(sheet, r, cols.concession)) : null;
    } else {
      // block: scan charge rows (including the unit row itself) until the next
      // unit row or a stop/skip boundary; bucket amounts by charge-code category.
      // Subsidy codes are a subset of rent codes (monthlyRent = total contract
      // rent), while discounts/concessions are separate adjustments.
      const sums = { rent: 0, subsidy: 0, discount: 0, concession: 0 };
      const saw = { rent: false, subsidy: false, discount: false, concession: false };
      for (let cr = r; cr <= range.e.r; cr++) {
        if (cr > r) {
          if (isUnitRow(cr)) break;
          const t = rowText(sheet, cr, Math.min(maxCol, 12));
          if (matchesAny(t, stops)) break;
        }
        const desc = readString(cellValue(sheet, cr, chargeDescCol!));
        const amt = readNumber(cellValue(sheet, cr, chargeAmtCol!));
        if (!desc || amt === null) continue;
        const code = desc.toLowerCase().trim();
        if (rentCodes.has(code)) { sums.rent += amt; saw.rent = true; }
        if (subsidyCodes.has(code)) { sums.subsidy += amt; saw.subsidy = true; }
        if (discountCodes.has(code)) { sums.discount += amt; saw.discount = true; }
        if (concessionCodes.has(code)) { sums.concession += amt; saw.concession = true; }
      }
      const cents = (n: number) => Math.round(n * 100) / 100;
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

    const unitType = cols.unitType !== null ? readString(cellValue(sheet, r, cols.unitType)) : null;
    const { category, includeInUnitCount } = classifyCategory(unitNumber, unitType);
    const sourceColumns = extraCols
      .map(ec => ({ header: ec.header, value: readString(cellValue(sheet, r, ec.index)) }))
      .filter((x): x is { header: string; value: string } => x.value !== null);

    units.push({
      unitNumber,
      status,
      category,
      includeInUnitCount,
      sourceColumns,
      monthlyRent,
      marketRent: cols.marketRent !== null ? readNumber(cellValue(sheet, r, cols.marketRent)) : null,
      subsidyRent,
      employeeDiscount,
      concession,
      tenantName: tenant,
      unitSqft: cols.unitSqft !== null ? readNumber(cellValue(sheet, r, cols.unitSqft)) : null,
      unitType,
      leaseStatus: rawStatus,
      moveInDate: cols.moveInDate !== null ? readDate(cellValue(sheet, r, cols.moveInDate)) : null,
      moveOutDate: cols.moveOutDate !== null ? readDate(cellValue(sheet, r, cols.moveOutDate)) : null,
      leaseStartDate: cols.leaseStartDate !== null ? readDateAt(sheet, r, cols.leaseStartDate, cols.leaseStartDate === cols.leaseEndDate ? 'start' : null) : null,
      leaseEndDate: cols.leaseEndDate !== null ? readDateAt(sheet, r, cols.leaseEndDate, cols.leaseStartDate === cols.leaseEndDate ? 'end' : null) : null,
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

  return {
    propertyName: null,
    statedTotalUnits: s.statedTotalUnits ?? null,
    statedSummary: s.statedSummary ?? {
      totalMonthlyRent: null, totalMarketRent: null, totalSqft: null,
      occupancyRate: null, occupiedUnits: null, vacantUnits: null,
    },
    units: [...byUnit.values()],
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

export async function tryFastPath(
  sheet: XLSX.WorkSheet,
  sampleText: string,
  usages: AIUsage[],
  external?: PreviewData | null
): Promise<{ result: ExtractionResult | null; reason?: string }> {
  try {
    let reason = '';
    const inventory = columnValueInventory(sheet);
    for (let attempt = 1; attempt <= 2; attempt++) {
      const hint = attempt > 1
        ? `\n\nNOTE: a previous structure mapping produced a walk that failed verification (${reason.slice(0, 300)}). Re-examine the layout — the usual causes are the wrong rent column (actual in-place rent vs market/scheduled rent vs total charges) or wrong skip/stop markers.`
        : '';
      const { structure, usage } = await mapSheetStructure(sampleText + inventory + hint);
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
        // The fast path must PROVE itself against stated anchors. A rent total
        // alone cannot catch a dropped null-rent unit (e.g. a vacant retail
        // row), so specifically require a stated unit COUNT.
        if (verification.ok && result.statedTotalUnits !== null) {
          const gap = coverageIssue(result, sampleText);
          if (!gap) return { result };
          reason = gap; // feeds the retry hint — a remapped attempt may fix it
          anchored = true;
          continue;
        }
        anchored = anchored || result.statedTotalUnits !== null;
        reason = result.statedTotalUnits === null
          ? 'the document states no unit count to prove the deterministic read against'
          : (verification.issues[0] ?? 'verification failed');
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
