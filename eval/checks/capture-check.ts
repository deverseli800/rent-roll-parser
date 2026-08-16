/**
 * Verifies the capture change on a synthetic charge-column sheet shaped like
 * the "Property A" example: per-code charge columns, a Legal Rent column the
 * mapper does NOT enumerate in extraColumns, and a decorative empty spacer.
 *
 * The point of the test: Legal Rent must survive even though extraColumns
 * omits it. Under the old allow-list it was dropped.
 */
import * as XLSX from 'xlsx';
import { applyStructure } from '../../src/lib/parsers/excelFastPath';

const rows = [
  ['Unit', 'Tenant', 'Regulation', 'Legal Rent', 'RC', 'PREF', 'S8', 'SCRIE', 'Total Charged', ''],
  ['C19', 'Tenant One', 'RS', 854.35, 854.35, 0, 0, -122.23, 732.12, ''],
  ['C20', 'Tenant Two', 'RS', 2444.28, 1278.01, -402.01, 1166.27, 0, 2042.27, ''],
];

const sheet = XLSX.utils.aoa_to_sheet(rows);

// Deliberately hostile mapper output: extraColumns lists ONLY the regulation
// column. Legal Rent is omitted — the exact failure this change targets.
const structure = {
  layout: 'row' as const,
  dataStartRow: 2,
  headerRow: 1,
  columns: {
    unitNumber: 0, status: -1, monthlyRent: -1, marketRent: -1, subsidyRent: -1,
    employeeDiscount: -1, concession: -1, tenantName: 1, tenantName2: -1,
    unitSqft: -1, unitType: -1, moveInDate: -1, moveOutDate: -1,
    leaseStartDate: -1, leaseEndDate: -1,
  },
  block: null,
  chargeColumns: [
    { header: 'RC', index: 4, kind: 'rent' as const },
    { header: 'PREF', index: 5, kind: 'rent' as const },
    { header: 'S8', index: 6, kind: 'subsidy' as const },
    { header: 'SCRIE', index: 7, kind: 'subsidy' as const },
  ],
  chargeTotalColumn: 8,
  skipPatterns: [],
  stopMarkers: [],
  statedTotalUnits: 2,
  statedSummary: {
    totalMonthlyRent: null, totalMarketRent: null, totalSqft: null,
    occupancyRate: null, occupiedUnits: null, vacantUnits: null,
  },
  extraColumns: [{ header: 'Regulation', index: 2 }],
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const result = applyStructure(sheet, structure as any);
if (!result) throw new Error('applyStructure returned null');

for (const u of result.units) {
  console.log(`\nunit ${u.unitNumber}  monthlyRent=${u.monthlyRent}`);
  console.log('  sourceColumns:', JSON.stringify(u.sourceColumns));
  console.log('  charges:', JSON.stringify(u.charges));
}

const c19 = result.units.find(u => u.unitNumber === 'C19')!;
const headers = (c19.sourceColumns ?? []).map(c => c.header);

const checks: [string, boolean][] = [
  ['Legal Rent captured despite mapper omitting it', headers.includes('Legal Rent')],
  ['Legal Rent value verbatim', (c19.sourceColumns ?? []).some(c => c.header === 'Legal Rent' && c.value === '854.35')],
  ['Regulation still captured', headers.includes('Regulation')],
  ['Tenant column captured even though promoted', headers.includes('Tenant')],
  ['Charge columns NOT duplicated into sourceColumns', !headers.some(h => ['RC', 'PREF', 'S8', 'SCRIE'].includes(h))],
  ['Unit id not duplicated', !headers.includes('Unit')],
  ['Empty spacer column dropped', !headers.some(h => h.startsWith('Column'))],
  ['Charge lines still verbatim', (c19.charges ?? []).some(c => c.code === 'SCRIE' && c.amount === -122.23)],
];

console.log('\n--- checks ---');
let failed = 0;
for (const [name, ok] of checks) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) failed++;
}
console.log(failed === 0 ? '\nall checks passed' : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
