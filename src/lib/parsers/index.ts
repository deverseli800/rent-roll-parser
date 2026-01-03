import { parseExcel } from './excel';
import { parsePDF } from './pdf';
import type { MVPUnit } from '../types';

export interface ParseResult {
  units: MVPUnit[];
  statedUnitCount: number | null;
  propertyName: string | null;
  sourceType: 'excel' | 'pdf';
  sourceFormat: string;
  pageCount: number | null;
}

/**
 * Parse a rent roll file (Excel or PDF)
 */
export async function parseRentRoll(
  buffer: Buffer,
  fileName: string
): Promise<ParseResult> {
  const extension = fileName.toLowerCase().split('.').pop();

  if (extension === 'xlsx' || extension === 'xls') {
    const result = await parseExcel(buffer);
    return {
      units: result.units,
      statedUnitCount: result.statedUnitCount,
      propertyName: null, // Excel parser doesn't extract property name yet
      sourceType: 'excel',
      sourceFormat: result.format,
      pageCount: null,
    };
  }

  if (extension === 'pdf') {
    const result = await parsePDF(buffer);
    return {
      units: result.units,
      statedUnitCount: result.statedUnitCount,
      propertyName: result.propertyName,
      sourceType: 'pdf',
      sourceFormat: result.format,
      pageCount: result.pageCount,
    };
  }

  throw new Error(`Unsupported file type: ${extension}`);
}

export { parseExcel } from './excel';
export { parsePDF } from './pdf';
