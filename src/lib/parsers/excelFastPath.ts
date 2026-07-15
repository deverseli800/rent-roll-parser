import * as XLSX from 'xlsx';
import { extractStructured, MODELS, type AIUsage } from './aiClient';
import {
  normalizeStatus,
  verifyAgainstStated,
  type ExtractionResult,
  type ExtractedUnit,
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
}

const numOrNull = { type: ['number', 'null'] } as const;
// Column indices use -1 as "absent" instead of null: the structured-outputs
// compiler limits schemas to 16 union-typed parameters.
const colIdx = { type: 'number', description: '0-based cell index, or -1 if this field is not present' } as const;

const STRUCTURE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['layout', 'dataStartRow', 'columns', 'block', 'skipPatterns', 'stopMarkers', 'statedTotalUnits', 'statedSummary'],
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
  },
};

const MAPPER_PROMPT = `You are analyzing the STRUCTURE of a rent roll Excel sheet so deterministic code can extract every unit. You see the first rows, a middle sample, and the last rows (rows labeled "R<n>:", cells separated by " | "; cell indices are 0-based counting each " | "-separated cell).

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
   concessionChargeCodes = codes for recurring concessions/credits (e.g. "conc", "concession"); NOT in rentChargeCodes.
5. skipPatterns: lowercase substrings identifying NON-unit rows to skip when they appear in the unit-number cell or the first cells (e.g. "total", "summary", floorplan group headers).
6. stopMarkers: lowercase substrings marking where unit data ENDS (e.g. "future residents/applicants", "summary groups", "unit type occupancy", "totals"). The walker stops at the first row containing any of these. Sections AFTER the stop (future residents, applicants, summaries) must not be extracted.
7. statedTotalUnits / statedSummary: totals STATED in the document itself (often in the last rows). null when absent. If the stated rent total is annual, divide by 12. totalMonthlyRent = the ACTUAL/current rent total; a stated market/potential/scheduled rent total goes in totalMarketRent (when only one rent total is stated, decide from its column/label which of the two it is).

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

/** Ask the mapper model for the sheet structure. */
export async function mapSheetStructure(
  sampleText: string
): Promise<{ structure: SheetStructure; usage: AIUsage }> {
  const { data, usage } = await extractStructured<SheetStructure>({
    model: MODELS.fast,
    content: [{ type: 'text', text: `${MAPPER_PROMPT}\n\n${sampleText}` }],
    schema: STRUCTURE_SCHEMA,
    maxTokens: 16000,
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
  s: SheetStructure
): ExtractionResult | null {
  if (s.layout === 'unsupported' || s.columns.unitNumber === null) return null;
  if (s.layout === 'block' && (!s.block || s.block.chargeDescCol === null || s.block.chargeAmtCol === null || s.block.rentChargeCodes.length === 0)) {
    return null;
  }

  const ref = sheet['!ref'];
  if (!ref) return null;
  const range = XLSX.utils.decode_range(ref);
  const maxCol = Math.min(range.e.c, 80);
  const skip = s.skipPatterns.map(p => p.toLowerCase()).filter(Boolean);
  const stops = s.stopMarkers.map(p => p.toLowerCase()).filter(Boolean);
  const rentCodes = new Set((s.block?.rentChargeCodes ?? []).map(c => c.toLowerCase().trim()));
  const subsidyCodes = new Set((s.block?.subsidyChargeCodes ?? []).map(c => c.toLowerCase().trim()));
  const discountCodes = new Set((s.block?.employeeDiscountChargeCodes ?? []).map(c => c.toLowerCase().trim()));
  const concessionCodes = new Set((s.block?.concessionChargeCodes ?? []).map(c => c.toLowerCase().trim()));

  const units: ExtractedUnit[] = [];
  const cols = s.columns;

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
        const desc = readString(cellValue(sheet, cr, s.block!.chargeDescCol!));
        const amt = readNumber(cellValue(sheet, cr, s.block!.chargeAmtCol!));
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

    units.push({
      unitNumber,
      status,
      monthlyRent,
      marketRent: cols.marketRent !== null ? readNumber(cellValue(sheet, r, cols.marketRent)) : null,
      subsidyRent,
      employeeDiscount,
      concession,
      tenantName: tenant,
      unitSqft: cols.unitSqft !== null ? readNumber(cellValue(sheet, r, cols.unitSqft)) : null,
      unitType: cols.unitType !== null ? readString(cellValue(sheet, r, cols.unitType)) : null,
      leaseStatus: rawStatus,
      moveInDate: cols.moveInDate !== null ? readDate(cellValue(sheet, r, cols.moveInDate)) : null,
      moveOutDate: cols.moveOutDate !== null ? readDate(cellValue(sheet, r, cols.moveOutDate)) : null,
      leaseStartDate: cols.leaseStartDate !== null ? readDateAt(sheet, r, cols.leaseStartDate, cols.leaseStartDate === cols.leaseEndDate ? 'start' : null) : null,
      leaseEndDate: cols.leaseEndDate !== null ? readDateAt(sheet, r, cols.leaseEndDate, cols.leaseStartDate === cols.leaseEndDate ? 'end' : null) : null,
    });
  }

  // Dedupe repeated unit numbers (applicant/renewal duplicate rows): keep the
  // higher-priority occupancy row, matching the prompt-side dedupe rule.
  const priority: Record<string, number> = { occupied: 5, notice: 4, applicant: 3, model: 2, down: 2, vacant: 1 };
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
export async function tryFastPath(
  sheet: XLSX.WorkSheet,
  sampleText: string,
  usages: AIUsage[]
): Promise<ExtractionResult | null> {
  try {
    const { structure, usage } = await mapSheetStructure(sampleText);
    usages.push(usage);
    const result = applyStructure(sheet, structure);
    if (!result || result.units.length === 0) return null;
    const verification = verifyAgainstStated(result);
    // The fast path must PROVE itself against stated anchors. A rent total
    // alone cannot catch a dropped null-rent unit (e.g. a vacant retail row),
    // so specifically require a stated unit COUNT to accept the fast result.
    if (!verification.ok || result.statedTotalUnits === null) return null;
    return result;
  } catch (e) {
    console.warn('[excelFastPath] failed, falling back to full AI:', e instanceof Error ? e.message : e);
    return null;
  }
}
