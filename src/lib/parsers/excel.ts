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
    // Additional fields
    unitSqft: z.number().nullable().describe('Column index for unit square footage'),
    unitType: z.number().nullable().describe('Column index for unit type (e.g., 1BR/1BA, Studio)'),
    leaseStatus: z.number().nullable().describe('Column index for raw lease status text'),
    moveInDate: z.number().nullable().describe('Column index for move-in date'),
    moveOutDate: z.number().nullable().describe('Column index for move-out date'),
    leaseStartDate: z.number().nullable().describe('Column index for lease start date'),
    leaseEndDate: z.number().nullable().describe('Column index for lease end date'),
  }),
  statedUnitCount: z.number().nullable().describe('Total unit count if stated in the document'),
  dataStartRow: z.number().describe('0-indexed row where actual unit data begins'),
  dataEndRow: z.number().nullable().describe('0-indexed row where unit data ends (before summary sections). null if no summary section found'),
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
  'vacant-leased': 'vacant', // Vacant but has pending applicant - will be superseded by applicant row
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

// Priority for choosing between duplicate unit rows (higher = prefer)
// When same unit appears multiple times, we keep the row with more useful info
const STATUS_PRIORITY: Record<UnitStatus, number> = {
  'occupied': 100,    // Highest - current tenant info
  'notice': 90,       // Has tenant info + notice status
  'applicant': 80,    // Has future tenant/rent info (prefer over vacant-leased)
  'model': 50,        // Special unit
  'down': 40,         // Special unit
  'vacant': 10,       // Lowest - no tenant info
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

interface AIResponse {
  mapping: ColumnMapping;
  modelUsed: string;
  inputTokens: number;
  outputTokens: number;
}

/**
 * Use Claude to analyze the Excel structure and map columns
 */
async function getColumnMappingFromAI(sheetText: string): Promise<AIResponse> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY environment variable is not set');
  }

  const client = new Anthropic({ apiKey });

  const prompt = `You are analyzing a rent roll Excel file to extract unit data. Below are rows from the spreadsheet (first rows for headers, last rows for totals/summaries).

Your task:
1. Identify which row contains the column headers (may span multiple rows - pick the most complete one)
2. Map the columns to these fields (use null if not found):
   PRIMARY FIELDS:
   - unitNumber: The unit identifier (e.g., "101", "A-201", "Unit 5")
   - status: Occupancy status column (occupied, vacant, notice, etc.)
   - monthlyRent: The rent amount (look for "Rent", "Market Rent", "Lease Rent")
   - tenantName: Tenant/resident name

   ADDITIONAL FIELDS:
   - unitSqft: Square footage (look for "SQFT", "Sq Ft", "Sq. Feet", "Square Footage")
   - unitType: Unit type/floorplan (look for "Type", "Floorplan", "BD/BA", "Unit Type" - values like "1BR/1BA", "A2", "Studio")
   - leaseStatus: Raw lease status if different from status (look for "Lease Status", "Unit/Lease Status")
   - moveInDate: Move-in date (look for "Move In", "Move-In", "MoveIn")
   - moveOutDate: Move-out date (look for "Move Out", "Move-Out", "MoveOut")
   - leaseStartDate: Lease start (look for "Lease Start", "Lease From", "Start Date")
   - leaseEndDate: Lease end (look for "Lease End", "Lease To", "Lease Expiration", "End Date")

3. Find any stated total unit count (e.g., "Total Units: 156", "208 units", "totals / averages:" row with a count)
4. Identify the row where actual unit data starts (after headers)
5. Identify the row where unit data ENDS - look for summary sections like "Unit Type Occupancy", "Total", "Summary", "Totals", etc. in the LAST ROWS section
6. List text patterns that indicate rows to skip

CRITICAL - DISTINGUISHING UNITS FROM SUMMARY DATA:
- Real unit numbers are specific identifiers like "101", "111", "A-201", "6435-1E"
- Summary sections may list UNIT TYPES (like "A1", "A2", "B1", "A3TH") which are NOT individual units
- If you see a section with unit type codes (A1, A2, B1, etc.) paired with aggregate statistics (Occupied/Vacant counts, totals), this is a SUMMARY SECTION - set dataEndRow to the row BEFORE this section
- The "Unit Type Occupancy" section is a common summary format - it lists unit types with their occupancy breakdown, NOT individual units

IMPORTANT:
- Column indices are 0-based (first column = 0)
- "Unit Type" or "Floorplan" columns are NOT the unit number column - they contain type codes like "A2", "1BR"
- Look for the column that contains actual unit identifiers (apartment numbers)
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
    "tenantName": <column index or null>,
    "unitSqft": <column index or null>,
    "unitType": <column index or null>,
    "leaseStatus": <column index or null>,
    "moveInDate": <column index or null>,
    "moveOutDate": <column index or null>,
    "leaseStartDate": <column index or null>,
    "leaseEndDate": <column index or null>
  },
  "statedUnitCount": <number or null>,
  "dataStartRow": <0-indexed row where unit data begins>,
  "dataEndRow": <0-indexed row where unit data ends, BEFORE any summary sections like "Unit Type Occupancy" or "Total". null if no summary section found>,
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
  return {
    mapping: ColumnMappingResponseSchema.parse(parsed),
    modelUsed: response.model,
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
  };
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
 * Parse a numeric value (rent amount, sqft)
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
 * Parse a date value to ISO string
 * Handles Excel serial dates and various string formats
 */
function parseDate(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;

  // Excel stores dates as numbers (days since 1900-01-01)
  if (typeof value === 'number') {
    // Excel date serial number
    const excelEpoch = new Date(1899, 11, 30); // Dec 30, 1899
    const date = new Date(excelEpoch.getTime() + value * 24 * 60 * 60 * 1000);
    if (!isNaN(date.getTime())) {
      return date.toISOString().split('T')[0];
    }
  }

  const str = String(value).trim();
  if (!str) return null;

  // Try parsing common date formats
  const date = new Date(str);
  if (!isNaN(date.getTime())) {
    return date.toISOString().split('T')[0];
  }

  // Try MM/DD/YYYY format
  const mdyMatch = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (mdyMatch) {
    const [, month, day, year] = mdyMatch;
    const fullYear = year.length === 2 ? (parseInt(year) > 50 ? `19${year}` : `20${year}`) : year;
    const parsed = new Date(`${fullYear}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`);
    if (!isNaN(parsed.getTime())) {
      return parsed.toISOString().split('T')[0];
    }
  }

  return null;
}

/**
 * Parse a string value (tenant name, unit type, etc.)
 */
function parseString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const str = String(value).trim();
  return str === '' ? null : str;
}

/**
 * Check if a row should be skipped based on patterns
 * Only checks the first cell (unit number column) to avoid false positives
 * from patterns appearing in tenant names or other columns
 */
function shouldSkipRow(row: unknown[], skipPatterns: string[], unitColIndex: number = 0): boolean {
  // Check the unit number cell specifically
  const unitCell = String(row[unitColIndex] ?? '').toLowerCase().trim();

  // Also check first few cells for section headers
  const firstCells = row.slice(0, 3).map(c => String(c ?? '').toLowerCase().trim()).join(' ');

  for (const pattern of skipPatterns) {
    const lowerPattern = pattern.toLowerCase();

    // For multi-word patterns, check if first cells start with them
    if (lowerPattern.includes(' ')) {
      if (firstCells.startsWith(lowerPattern)) {
        return true;
      }
    } else {
      // For single-word patterns (like "total", "model"), require exact match
      // or that the cell STARTS with the pattern (not just contains it)
      // This prevents "713 - Model" from matching "model" pattern
      if (unitCell === lowerPattern || unitCell.startsWith(lowerPattern + ' ') || firstCells.startsWith(lowerPattern)) {
        return true;
      }
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
  modelUsed: string;
  inputTokens: number;
  outputTokens: number;
}> {
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];

  // Convert first rows to text for Claude analysis
  const sheetText = sheetToText(sheet, 35);

  // Get column mapping from AI
  const aiResponse = await getColumnMappingFromAI(sheetText);
  const mapping = aiResponse.mapping;

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
    'unit type occupancy',
  ];

  // Determine where to stop extraction (use dataEndRow if provided, otherwise end of sheet)
  const endRow = mapping.dataEndRow !== null ? mapping.dataEndRow : range.e.r;

  for (let r = mapping.dataStartRow; r <= endRow; r++) {
    const row: unknown[] = [];
    for (let c = range.s.c; c <= range.e.c; c++) {
      const cell = sheet[XLSX.utils.encode_cell({ r, c })];
      row.push(cell ? cell.v : null);
    }

    // Skip rows matching patterns (check unit column specifically)
    if (shouldSkipRow(row, skipPatterns, mapping.columns.unitNumber ?? 0)) {
      continue;
    }

    // Get unit number
    const unitValue = row[mapping.columns.unitNumber];
    if (!isValidUnitNumber(unitValue)) {
      continue;
    }

    const unitNumber = String(unitValue).trim();
    const unitKey = unitNumber.toUpperCase();

    // Build the unit object - primary fields
    const status = mapping.columns.status !== null
      ? normalizeStatus(row[mapping.columns.status])
      : 'occupied';
    const monthlyRent = mapping.columns.monthlyRent !== null
      ? parseNumber(row[mapping.columns.monthlyRent])
      : null;
    const tenantName = mapping.columns.tenantName !== null
      ? parseString(row[mapping.columns.tenantName])
      : null;

    // Additional fields (all optional)
    const unitSqft = mapping.columns.unitSqft !== null
      ? parseNumber(row[mapping.columns.unitSqft])
      : null;
    const unitType = mapping.columns.unitType !== null
      ? parseString(row[mapping.columns.unitType])
      : null;
    const leaseStatus = mapping.columns.leaseStatus !== null
      ? parseString(row[mapping.columns.leaseStatus])
      : (mapping.columns.status !== null ? parseString(row[mapping.columns.status]) : null);
    const moveInDate = mapping.columns.moveInDate !== null
      ? parseDate(row[mapping.columns.moveInDate])
      : null;
    const moveOutDate = mapping.columns.moveOutDate !== null
      ? parseDate(row[mapping.columns.moveOutDate])
      : null;
    const leaseStartDate = mapping.columns.leaseStartDate !== null
      ? parseDate(row[mapping.columns.leaseStartDate])
      : null;
    const leaseEndDate = mapping.columns.leaseEndDate !== null
      ? parseDate(row[mapping.columns.leaseEndDate])
      : null;

    const unit: MVPUnit = {
      unitNumber,
      status,
      monthlyRent,
      tenantName,
      unitSqft,
      unitType,
      leaseStatus,
      moveInDate,
      moveOutDate,
      leaseStartDate,
      leaseEndDate,
      sourceRow: r + 1,
    };

    // Handle duplicates: keep the row with higher priority status
    // This handles cases like Vacant-Leased + Applicant (prefer Applicant)
    if (seenUnits.has(unitKey)) {
      const existingIndex = units.findIndex(u => u.unitNumber.toUpperCase() === unitKey);
      if (existingIndex !== -1) {
        const existing = units[existingIndex];
        const existingPriority = STATUS_PRIORITY[existing.status] || 0;
        const newPriority = STATUS_PRIORITY[status] || 0;

        // Replace if new row has higher priority, or same priority but more data
        if (newPriority > existingPriority ||
            (newPriority === existingPriority && tenantName && !existing.tenantName)) {
          units[existingIndex] = unit;
        }
      }
      continue;
    }
    seenUnits.add(unitKey);

    units.push(unit);
  }

  return {
    units,
    statedUnitCount: mapping.statedUnitCount,
    format: `ai-mapped (header row ${mapping.headerRow})`,
    modelUsed: aiResponse.modelUsed,
    inputTokens: aiResponse.inputTokens,
    outputTokens: aiResponse.outputTokens,
  };
}
