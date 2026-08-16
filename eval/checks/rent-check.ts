/**
 * Acceptance cases from the charge-category handoff, run against the walker.
 * Amounts are the doc's exact figures; property/tenant names are invented.
 */
import * as XLSX from 'xlsx';
import { applyStructure } from '../../src/lib/parsers/excelFastPath';

const EMPTY_COLS = {
  unitNumber: -1, status: -1, monthlyRent: -1, marketRent: -1, subsidyRent: -1,
  employeeDiscount: -1, concession: -1, tenantName: -1, tenantName2: -1,
  unitSqft: -1, unitType: -1, moveInDate: -1, moveOutDate: -1,
  leaseStartDate: -1, leaseEndDate: -1,
};
const EMPTY_SUMMARY = {
  totalMonthlyRent: null, totalMarketRent: null, totalSqft: null,
  occupancyRate: null, occupiedUnits: null, vacantUnits: null,
};

// ---------------------------------------------------------------- column roll
// Legal Rent | RC | PREF | S8 | SCRIE | Total Charged
const colSheet = XLSX.utils.aoa_to_sheet([
  ['Unit', 'Legal Rent', 'RC', 'PREF', 'S8', 'SCRIE', 'Total Charged'],
  ['C19', 854.35, 854.35, 0, 0, -122.23, 732.12],
  ['C20', 2444.28, 1278.01, -402.01, 1166.27, 0, 2042.27],
]);
const colStructure = {
  layout: 'row' as const, dataStartRow: 2, headerRow: 1,
  columns: { ...EMPTY_COLS, unitNumber: 0 },
  block: null,
  chargeColumns: [
    { header: 'RC', index: 2, kind: 'rent' as const },
    // The mapper is told preferential reductions are concessions now.
    { header: 'PREF', index: 3, kind: 'concession' as const },
    { header: 'S8', index: 4, kind: 'subsidy' as const },
    // Deliberately mis-mapped as subsidy: the column's negative sign must
    // reclassify it without the mapper's help. This is the Property A defect.
    { header: 'SCRIE', index: 5, kind: 'subsidy' as const },
  ],
  chargeTotalColumn: 6,
  skipPatterns: [], stopMarkers: [], statedTotalUnits: 2, statedSummary: EMPTY_SUMMARY,
  extraColumns: [{ header: 'Legal Rent', index: 1 }],
};

// ----------------------------------------------------------------- block roll
const blockSheet = XLSX.utils.aoa_to_sheet([
  ['Unit', 'Charge', 'Amount'],
  ['2B', '', ''],
  ['', 'SRR Stabilized Rent', 3432.90],
  ['', 'PRD Preferred Rent Discount', -887.77],
  ['', 'Resident Totals', 2545.13],
  ['4C', '', ''],
  ['', 'RT', 957.44],
  ['', 'SCR', -273.42],
  ['', 'Charge Total', 684.02],
]);
const blockStructure = {
  layout: 'block' as const, dataStartRow: 2, headerRow: 1,
  columns: { ...EMPTY_COLS, unitNumber: 0 },
  block: {
    chargeDescCol: 1, chargeAmtCol: 2,
    rentChargeCodes: ['srr stabilized rent', 'rt'],
    subsidyChargeCodes: [],
    employeeDiscountChargeCodes: [],
    concessionChargeCodes: ['prd preferred rent discount'],
    reimbursedCreditChargeCodes: ['scr'],
  },
  chargeColumns: [], chargeTotalColumn: null,
  skipPatterns: [], stopMarkers: [], statedTotalUnits: 2, statedSummary: EMPTY_SUMMARY,
  extraColumns: [],
};

/* eslint-disable @typescript-eslint/no-explicit-any */
const colUnits = applyStructure(colSheet, colStructure as any)!.units;
const blockUnits = applyStructure(blockSheet, blockStructure as any)!.units;
/* eslint-enable @typescript-eslint/no-explicit-any */

for (const u of [...colUnits, ...blockUnits]) {
  console.log(`${u.unitNumber}: rent=${u.monthlyRent} subsidy=${u.subsidyRent} concession=${u.concession}`);
  console.log(`   charges: ${JSON.stringify(u.charges)}`);
}

const c19 = colUnits.find(u => u.unitNumber === 'C19')!;
const c20 = colUnits.find(u => u.unitNumber === 'C20')!;
const b2b = blockUnits.find(u => u.unitNumber === '2B')!;
const b4c = blockUnits.find(u => u.unitNumber === '4C')!;
const catOf = (u: typeof c19, code: string) => (u.charges ?? []).find(c => c.code === code)?.category;

const checks: [string, boolean][] = [
  // Case 1 — negative exemption column: rent is NOT net of the credit.
  ['1. SCRIE reclassified to reimbursed_credit from column sign', catOf(c19, 'SCRIE') === 'reimbursed_credit'],
  ['1. C19 monthlyRent = 854.35 (was 732.12)', c19.monthlyRent === 854.35],
  ['1. SCRIE line still captured verbatim', (c19.charges ?? []).some(c => c.code === 'SCRIE' && c.amount === -122.23)],

  // Case 2 — preferential column: owner-borne, so rent IS net.
  ['2. PREF categorized concession', catOf(c20, 'PREF') === 'concession'],
  ['2. S8 stays subsidy', catOf(c20, 'S8') === 'subsidy'],
  ['2. C20 monthlyRent = 2042.27 (matches Total Charged)', c20.monthlyRent === 2042.27],
  ['2. C20 subsidy reported separately = 1166.27', c20.subsidyRent === 1166.27],
  ['2. C20 concession reported separately = -402.01', c20.concession === -402.01],
  ['2. Legal Rent 2444.28 recoverable from raw',
    (c20.sourceColumns ?? []).some(s => s.header === 'Legal Rent' && s.value === '2444.28')],

  // Case 3 — preferential block row, non-obvious code, no string matching.
  ['3. PRD categorized concession', catOf(b2b, 'PRD Preferred Rent Discount') === 'concession'],
  ['3. 2B monthlyRent = 2545.13 (was 3432.90 gross)', b2b.monthlyRent === 2545.13],
  ['3. 2B matches the document printed Resident Totals', b2b.monthlyRent === 2545.13],

  // Case 4 — exemption block row: the case that breaks if the whole
  // concession bucket is subtracted wholesale.
  ['4. SCR categorized reimbursed_credit', catOf(b4c, 'SCR') === 'reimbursed_credit'],
  ['4. 4C monthlyRent = 957.44, NOT 684.02', b4c.monthlyRent === 957.44],
];

console.log('\n--- acceptance cases ---');
let failed = 0;
for (const [name, ok] of checks) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) failed++;
}
console.log(failed === 0 ? '\nall acceptance cases passed' : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
