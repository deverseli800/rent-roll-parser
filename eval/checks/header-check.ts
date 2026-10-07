/**
 * Verifies that captured columns are labelled from the header BLOCK, not one
 * header-row cell. Synthetic sheets only.
 *
 * The cases: a header printed over two rows, a label sitting above a blank
 * header-row cell, merged header cells, and — the other half — the rows that
 * must NOT be read as part of a header (report title, "As Of" line, metadata
 * block, totals row), plus a single-row header that has to come out unchanged.
 */
import * as XLSX from 'xlsx';
import { applyStructure } from '../../src/lib/parsers/excelFastPath';

type Row = (string | number)[];

const baseColumns = {
  unitNumber: 0, status: -1, monthlyRent: -1, marketRent: -1, subsidyRent: -1,
  employeeDiscount: -1, concession: -1, tenantName: -1, tenantName2: -1,
  unitSqft: -1, unitType: -1, moveInDate: -1, moveOutDate: -1,
  leaseStartDate: -1, leaseEndDate: -1,
};

function headersOf(
  rows: Row[],
  headerRow: number,
  opts: {
    columns?: Partial<typeof baseColumns>;
    extraColumns?: { header: string; index: number }[];
    merges?: string[];
  } = {}
): string[] {
  const sheet = XLSX.utils.aoa_to_sheet(rows);
  if (opts.merges) sheet['!merges'] = opts.merges.map(m => XLSX.utils.decode_range(m));
  const structure = {
    layout: 'row' as const,
    dataStartRow: headerRow + 1,
    headerRow,
    columns: { ...baseColumns, ...opts.columns },
    block: null,
    chargeColumns: [],
    chargeTotalColumn: -1,
    skipPatterns: ['total'],
    stopMarkers: [],
    statedTotalUnits: null,
    statedSummary: {
      totalMonthlyRent: null, totalMarketRent: null, totalSqft: null,
      occupancyRate: null, occupiedUnits: null, vacantUnits: null,
    },
    extraColumns: opts.extraColumns ?? [],
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result = applyStructure(sheet, structure as any);
  if (!result || result.units.length === 0) throw new Error('applyStructure produced no units');
  return (result.units[0].sourceColumns ?? []).map(c => c.header);
}

const same = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);
const data: Row[] = [
  ['101', 850, 'Tenant One', 2100, '1/1/24', '12/31/26', '1 Bed'],
  ['102', 910, 'Tenant Two', 2250, '3/1/25', '2/28/27', '2 Bed'],
];
const mapped = { unitSqft: 1, tenantName: 2, monthlyRent: 3, moveInDate: 4, leaseEndDate: 5, unitType: 6 };

// 1. Two-row header under a title block, with a section label between header and data.
const stacked = headersOf([
  ['Residential Rent Roll'],
  ['Example Owner LLC (1234)'],
  ['As Of = 08/04/2026'],
  ['Month Year = 08/2026'],
  ['Unit', 'Unit', 'Name', 'Actual', 'Move In', 'Lease', 'Unit'],
  ['', 'Sq Ft', '', 'Rent', '', 'Expiration', 'Type'],
  ...data,
], 6, { columns: mapped });

// 2. Single-row header directly under a title and an "As Of" line: unchanged.
const single = headersOf([
  ['Residential Rent Roll', '', '', '', '', '', 'Page 1'],
  ['As Of 08/04/2026', 'Example Owner LLC'],
  ['Unit', 'Sq Ft', 'Name', 'Rent', 'Move In', 'Expiration', 'Type'],
  ...data,
], 3, { columns: mapped });

// 3. Metadata block and a totals row directly above a single-row header.
const metadata = headersOf([
  ['Borrower: Example Owner LLC', 'Loan: 000123', 'Property: 124 Main Street'],
  ['Total', 1760, '', 4350, '', '', ''],
  ['Unit', 'Sq Ft', 'Name', 'Rent', 'Move In', 'Expiration', 'Type'],
  ...data,
], 3, { columns: mapped });

// 4. The mapper's header text: kept when it is the full label, replaced only
//    when it is just the bottom line of a stacked one.
const mapperText = headersOf([
  ['Unit', 'Unit', 'Name', 'Actual', 'Move In', 'Lease', 'Unit'],
  ['', 'Sq Ft', '', 'Rent', '', 'Expiration', 'Type'],
  ...data,
], 2, {
  extraColumns: [
    { header: 'Sq Ft', index: 1 },
    { header: 'Resident Name', index: 2 },
    { header: 'Lease Exp.', index: 5 },
  ],
});

// 5. Merged cells: a group band over two columns, and a label merged down both rows.
const merged = headersOf([
  ['Unit', 'Name', 'Lease', '', 'Rent', 'Charges', ''],
  ['', '', 'Start', 'End', '', 'Pet', 'Parking'],
  ['101', 'Tenant One', '1/1/24', '12/31/26', 2100, 50, 75],
], 2, { merges: ['A1:A2', 'B1:B2', 'C1:D1', 'E1:E2', 'F1:G1'] });

// 6. A title merged across the whole sheet is not a group band.
const mergedTitle = headersOf([
  ['Residential Rent Roll', '', '', '', '', '', 'Page 1'],
  ['Unit', 'Sq Ft', 'Name', 'Rent', 'Move In', 'Expiration', 'Type'],
  ...data,
], 2, { merges: ['A1:F1'] });

// 7. A header cell merged across two populated columns must not name both.
const mergedPair = headersOf([
  ['Unit', 'Name', 'Rent', '', 'Type'],
  ['101', 'Tenant One', 2100, 2150, '1 Bed'],
], 1, { merges: ['C1:D1'] });

const plain = ['Sq Ft', 'Name', 'Rent', 'Move In', 'Expiration', 'Type'];
const checks: [string, boolean, string[]][] = [
  ['Stacked header joined; title and As-Of lines excluded',
    same(stacked, ['Unit Sq Ft', 'Name', 'Actual Rent', 'Move In', 'Lease Expiration', 'Unit Type']), stacked],
  ['Single-row header under a title is unchanged', same(single, plain), single],
  ['Metadata block and totals row never prepended', same(metadata, plain), metadata],
  ['Mapper text kept unless it is only the bottom line',
    same(mapperText, ['Unit Sq Ft', 'Resident Name', 'Actual Rent', 'Move In', 'Lease Exp.', 'Unit Type']), mapperText],
  ['Merged group band and vertical merges resolved',
    same(merged, ['Name', 'Lease Start', 'Lease End', 'Rent', 'Charges Pet', 'Charges Parking']), merged],
  ['Sheet-wide merged title is not a label row', same(mergedTitle, plain), mergedTitle],
  ['Horizontally merged header does not name two columns',
    same(mergedPair, ['Name', 'Rent', 'Column D', 'Type']), mergedPair],
];

console.log('--- checks ---');
let failed = 0;
for (const [name, ok, got] of checks) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n      got: ${JSON.stringify(got)}`}`);
  if (!ok) failed++;
}
console.log(failed === 0 ? '\nall checks passed' : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
