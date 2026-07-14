/**
 * Generate text previews of every corpus file for triage and ground-truth work.
 * Excel: all sheets as CSV (full). PDF: pdftotext -layout output (full) + page count.
 * Writes eval/previews/<id>.txt
 *
 * Usage: npx tsx eval/preview-corpus.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import * as XLSX from 'xlsx';

const CORPUS_DIR = path.join(__dirname, 'corpus');
const PREVIEWS_DIR = path.join(__dirname, 'previews');

fs.mkdirSync(PREVIEWS_DIR, { recursive: true });

const files = fs.readdirSync(CORPUS_DIR).sort();
const summary: string[] = [];

for (const f of files) {
  const filePath = path.join(CORPUS_DIR, f);
  const ext = path.extname(f).toLowerCase();
  let out = '';
  let info = '';

  try {
    if (['.xlsx', '.xls', '.xlsm'].includes(ext)) {
      const wb = XLSX.readFile(filePath);
      const sheetInfos: string[] = [];
      for (const name of wb.SheetNames) {
        const sheet = wb.Sheets[name];
        const ref = sheet['!ref'] || 'A1';
        const range = XLSX.utils.decode_range(ref);
        const rows = range.e.r - range.s.r + 1;
        const cols = range.e.c - range.s.c + 1;
        sheetInfos.push(`${name} (${rows}x${cols})`);
        out += `\n===== SHEET: ${name} (${rows} rows x ${cols} cols) =====\n`;
        out += XLSX.utils.sheet_to_csv(sheet, { blankrows: false });
        out += '\n';
      }
      info = `sheets: ${sheetInfos.join(', ')}`;
    } else if (ext === '.pdf') {
      let pages = '?';
      try {
        const pdfinfo = execSync(`pdfinfo "${filePath}"`, { timeout: 10000 }).toString();
        pages = pdfinfo.match(/Pages:\s+(\d+)/)?.[1] ?? '?';
      } catch { /* ignore */ }
      let text = '';
      try {
        text = execSync(`pdftotext -layout "${filePath}" -`, {
          timeout: 30000, maxBuffer: 20 * 1024 * 1024,
        }).toString();
      } catch { text = '(pdftotext failed)'; }
      const textLen = text.replace(/\s/g, '').length;
      info = `pages: ${pages}, extracted chars: ${textLen}${textLen < 100 ? ' (LIKELY SCANNED)' : ''}`;
      out = `PDF pages: ${pages}\n\n${text}`;
    }
  } catch (e) {
    info = `ERROR: ${e instanceof Error ? e.message : e}`;
    out = info;
  }

  fs.writeFileSync(path.join(PREVIEWS_DIR, f + '.txt'), out);
  summary.push(`${f}\n    ${info}`);
}

fs.writeFileSync(path.join(__dirname, 'previews-summary.txt'), summary.join('\n'));
console.log(summary.join('\n'));
