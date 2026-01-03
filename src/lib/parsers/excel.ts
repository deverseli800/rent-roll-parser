import * as XLSX from 'xlsx';
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import type { MVPUnit, UnitStatus } from '../types';

/**
 * AI-Assisted Excel Parser
 *
 * Uses Claude to intelligently:
 * 1. Identify the header row
 * 2. Map columns to our schema
 * 3. Find stated unit counts for verification
 * 4. Identify patterns to skip (section headers, totals)
 */

// Schema for Claude's column mapping response
const ColumnMappingResponseSchema = z.object({
  headerRow: z.number().describe('0-indexed row number containing column headers'),
  columns: z.object({
    unitNumber: z.number().nullable().describe('Column index for unit number/ID'),
    status: z.number().nullable().describe('Column index for occupancy status'),
    monthlyRent: z.number().nullable().describe('Column index for rent amount'),
    tenantName: z.number().nullable().describe('Column index for tenant/resident name'),
  }),
  statedUnitCount: z.number().nullable().describe('Total unit count if stated in the document'),
  dataStartRow: z.number().describe('0-indexed row where actual unit data begins'),
  skipPatterns: z.array(z.string()).describe('Text patterns that indicate non-unit rows (section headers, totals)'),
  notes: z.string().optional().describe('Any observations about the file format'),
});

type ColumnMapping = z.infer<typeof ColumnMappingResponseSchema>;

// Status value mappings
const STATUS_MAPPINGS: Record<string, UnitStatus> = {
  'occupied': 'occupied',
  'current': 'occupied',
  'c': 'occupied',
  'leased': 'occupied',
  'rented': 'occupied',
  'resident': 'occupied',
  'occupied-ntv': 'notice',
  'pending renewal': 'occupied',
  'vacant': 'vacant',
  'vacant unit': 'vacant',
  'v': 'vacant',
  'available': 'vacant',
  'ready': 'vacant',
  'vacant-ready': 'vacant',
  'notice': 'notice',
  'ntv': 'notice',
  'notice to vacate': 'notice',
  'n': 'notice',
  'model': 'model',
  'm': 'model',
  'down': 'down',
  'd': 'down',
  'offline': 'down',
  'applicant': 'applicant',
  'application': 'applicant',
  'pending': 'applicant',
  'approved': 'applicant',
};

/**
 * Convert sheet data to a text representation for Claude
 * Includes first rows (for headers) and last rows (for totals)
 */
function sheetToText(sheet: XLSX.WorkSheet, firstRows: number = 35, lastRows: number = 70): string {
  const range = XLSX.utils.decode_range(sheet['!ref'] || 'A1');
  const lines: string[] = [];
  const totalRows = range.e.r - range.s.r + 1;

  const endCol = Math.min(range.e.c, 20); // Limit columns to avoid token overflow

  // First N rows (headers and initial data)
  const firstEndRow = Math.min(range.s.r + firstRows - 1, range.e.r);
  for (let r = range.s.r; r <= firstEndRow; r++) {
    const cells: string[] = [];
    for (let c = range.s.c; c <= endCol; c++) {
      const cell = sheet[XLSX.utils.encode_cell({ r, c })];
      const value = cell ? String(cell.v ?? '').trim() : '';
      cells.push(value || '(empty)');
    }
    lines.push(`Row ${r}: [${cells.join(' | ')}]`);
  }

  // If file is large enough, add last N rows (where totals typically appear)
  const lastStartRow = range.e.r - lastRows + 1;
  if (lastStartRow > firstEndRow + 1) {
    lines.push('');
    lines.push(`... (${lastStartRow - firstEndRow - 1} rows omitted) ...`);
    lines.push('');
    lines.push('=== LAST ROWS (check for totals) ===');

    for (let r = lastStartRow; r <= range.e.r; r++) {
      const cells: string[] = [];
      for (let c = range.s.c; c <= endCol; c++) {
        const cell = sheet[XLSX.utils.encode_cell({ r, c })];
        const value = cell ? String(cell.v ?? '').trim() : '';
        cells.push(value || '(empty)');
      }
      lines.push(`Row ${r}: [${cells.join(' | ')}]`);
    }
  }

  lines.push('');
  lines.push(`Total rows in file: ${totalRows}`);

  return lines.join('\n');
}

/**
 * Use Claude to analyze the Excel structure and map columns
 */
async function getColumnMappingFromAI(sheetText: string): Promise<ColumnMapping> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY environment variable is not set');
  }

  const client = new Anthropic({ apiKey });

  const prompt = `You are analyzing a rent roll Excel file to extract unit data. Below are the first rows of the spreadsheet.

Your task:
1. Identify which row contains the column headers (may span multiple rows - pick the most complete one)
2. Map the columns to these fields:
   - unitNumber: The unit identifier (e.g., "101", "A-201", "Unit 5")
   - status: Occupancy status (occupied, vacant, notice, etc.)
   - monthlyRent: The rent amount
   - tenantName: Tenant/resident name
3. Find any stated total unit count (e.g., "Total Units: 156", "208 units", summary rows)
4. Identify the row where actual unit data starts (after headers)
5. List text patterns that indicate rows to skip (section headers like "Current Residents", totals, subtotals)

IMPORTANT:
- Column indices are 0-based (first column = 0)
- "Unit Type" or "Unit Sqft" are NOT the unit number column
- Look for the column that contains actual unit identifiers like "101", "A-201", "6435-1E"
- The rent column should have dollar amounts, not codes
- If a field isn't present, use null

Here are the rows:

${sheetText}

Respond with ONLY valid JSON matching this structure:
{
  "headerRow": <0-indexed row number>,
  "columns": {
    "unitNumber": <column index or null>,
    "status": <column index or null>,
    "monthlyRent": <column index or null>,
    "tenantName": <column index or null>
  },
  "statedUnitCount": <number or null>,
  "dataStartRow": <0-indexed row where unit data begins>,
  "skipPatterns": ["pattern1", "pattern2"],
  "notes": "optional observations"
}`;

  const response = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1000,
    messages: [
      {
        role: 'user',
        content: prompt,
      },
    ],
  });

  const textContent = response.content.find(c => c.type === 'text');
  if (!textContent || textContent.type !== 'text') {
    throw new Error('No text response from Claude');
  }

  // Extract JSON from response
  const jsonMatch = textContent.text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error('Could not find JSON in Claude response: ' + textContent.text);
  }

  const parsed = JSON.parse(jsonMatch[0]);
  return ColumnMappingResponseSchema.parse(parsed);
}

/**
 * Normalize status value to our enum
 */
function normalizeStatus(value: unknown): UnitStatus {
  if (!value) return 'vacant';
  const normalized = String(value).toLowerCase().trim();
  return STATUS_MAPPINGS[normalized] || 'occupied';
}

/**
 * Parse a numeric value (rent amount)
 */
function parseNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return value;

  const cleaned = String(value)
    .replace(/[$,]/g, '')
    .replace(/[()]/g, '-')
    .trim();

  const num = parseFloat(cleaned);
  return isNaN(num) ? null : num;
}

/**
 * Check if a row should be skipped based on patterns
 */
function shouldSkipRow(row: unknown[], skipPatterns: string[]): boolean {
  const rowText = row.map(c => String(c ?? '').toLowerCase()).join(' ');

  for (const pattern of skipPatterns) {
    if (rowText.includes(pattern.toLowerCase())) {
      return true;
    }
  }

  return false;
}

/**
 * Check if a value looks like a valid unit number
 */
function isValidUnitNumber(value: unknown): boolean {
  if (!value) return false;
  const str = String(value).trim();

  // Must have some content
  if (!str || str === '(empty)') return false;

  // Should contain at least one digit (unit numbers typically have numbers)
  if (!/\d/.test(str)) return false;

  // Shouldn't be too long
  if (str.length > 30) return false;

  // Shouldn't be just a large number (likely a code, not unit)
  if (/^\d{6,}$/.test(str)) return false;

  return true;
}

/**
 * Parse Excel file using AI-assisted column mapping
 */
export async function parseExcel(buffer: Buffer): Promise<{
  units: MVPUnit[];
  statedUnitCount: number | null;
  format: string;
}> {
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];

  // Convert first rows to text for Claude analysis
  const sheetText = sheetToText(sheet, 35);

  // Get column mapping from AI
  const mapping = await getColumnMappingFromAI(sheetText);

  if (mapping.columns.unitNumber === null) {
    throw new Error('AI could not identify the unit number column');
  }

  // Extract all data using the AI-provided mapping
  const range = XLSX.utils.decode_range(sheet['!ref'] || 'A1');
  const units: MVPUnit[] = [];
  const seenUnits = new Set<string>();

  // Default skip patterns + AI-provided ones
  const skipPatterns = [
    ...mapping.skipPatterns,
    'total',
    'subtotal',
    'grand total',
    'summary',
  ];

  for (let r = mapping.dataStartRow; r <= range.e.r; r++) {
    const row: unknown[] = [];
    for (let c = range.s.c; c <= range.e.c; c++) {
      const cell = sheet[XLSX.utils.encode_cell({ r, c })];
      row.push(cell ? cell.v : null);
    }

    // Skip rows matching patterns
    if (shouldSkipRow(row, skipPatterns)) {
      continue;
    }

    // Get unit number
    const unitValue = row[mapping.columns.unitNumber];
    if (!isValidUnitNumber(unitValue)) {
      continue;
    }

    const unitNumber = String(unitValue).trim();

    // Skip duplicates (handles multi-row-per-unit formats)
    if (seenUnits.has(unitNumber.toUpperCase())) {
      continue;
    }
    seenUnits.add(unitNumber.toUpperCase());

    const unit: MVPUnit = {
      unitNumber,
      status: mapping.columns.status !== null
        ? normalizeStatus(row[mapping.columns.status])
        : 'occupied',
      monthlyRent: mapping.columns.monthlyRent !== null
        ? parseNumber(row[mapping.columns.monthlyRent])
        : null,
      tenantName: mapping.columns.tenantName !== null
        ? row[mapping.columns.tenantName] ? String(row[mapping.columns.tenantName]).trim() : null
        : null,
      sourceRow: r + 1,
    };

    units.push(unit);
  }

  return {
    units,
    statedUnitCount: mapping.statedUnitCount,
    format: `ai-mapped (header row ${mapping.headerRow})`,
  };
}
