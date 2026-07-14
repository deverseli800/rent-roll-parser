import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';
dotenv.config({ path: path.join(process.cwd(), '.env.local') });
import * as XLSX from 'xlsx';
import { mapSheetStructure, applyStructure } from '../src/lib/parsers/excelFastPath';
import { verifyAgainstStated } from '../src/lib/parsers/extractionCore';

async function main() {
  const id = process.argv[2];
  const file = fs.readdirSync('eval/corpus').find(f => f.startsWith(id))!;
  const wb = XLSX.read(fs.readFileSync(path.join('eval/corpus', file)), { type: 'buffer', cellDates: false, cellNF: true, cellText: true });
  const sheetName = wb.SheetNames.find(n => /report1|sheet1|burroughs/i.test(n)) ?? wb.SheetNames[0];
  const sheet = wb.Sheets[sheetName];
  // build grid sample like the parser does (simplified: use sheet_to_csv rows)
  const range = XLSX.utils.decode_range(sheet['!ref']!);
  const lines: string[] = [];
  for (let r = range.s.r; r <= range.e.r; r++) {
    const cells: string[] = [];
    for (let c = range.s.c; c <= Math.min(range.e.c, 60); c++) {
      const cell = sheet[XLSX.utils.encode_cell({ r, c })];
      cells.push(cell?.v !== undefined ? String(cell.v).trim() : '');
    }
    if (cells.some(x => x)) lines.push(`R${r + 1}: ${cells.join(' | ')}`);
  }
  const sample = lines.length > 130
    ? [...lines.slice(0, 50), '...', ...lines.slice(-60)].join('\n')
    : lines.join('\n');
  const { structure } = await mapSheetStructure(sample);
  console.log('STRUCTURE:', JSON.stringify(structure, null, 1).slice(0, 1200));
  const result = applyStructure(sheet, structure);
  if (!result) { console.log('applyStructure -> null'); return; }
  console.log('walked units:', result.units.length, 'rent sum:', result.units.reduce((s, u) => s + (u.monthlyRent ?? 0), 0).toFixed(2));
  const dist: Record<string, number> = {};
  for (const u of result.units) dist[u.status] = (dist[u.status] ?? 0) + 1;
  console.log('status dist:', dist);
  console.log('sample raw:', result.units.slice(0, 3).map(u => ({ n: u.unitNumber, ls: u.leaseStatus, t: u.tenantName })));
  console.log('verification:', JSON.stringify(verifyAgainstStated(result)));
}
main();
