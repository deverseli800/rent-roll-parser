import { parseExcel } from './excel';
import { parsePDF } from './pdf';
import type { MVPUnit, StatedSummaryStats } from '../types';

export interface ParseResult {
  units: MVPUnit[];
  statedUnitCount: number | null;
  statedSummaryStats: StatedSummaryStats | null;
  propertyName: string | null;
  sourceType: 'excel' | 'pdf';
  sourceFormat: string;
  pageCount: number | null;
  // AI usage tracking
  modelUsed: string;
  inputTokens: number;
  outputTokens: number;
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
      statedSummaryStats: result.statedSummaryStats,
      propertyName: null, // Excel parser doesn't extract property name yet
      sourceType: 'excel',
      sourceFormat: result.format,
      pageCount: null,
      modelUsed: result.modelUsed,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
    };
  }

  if (extension === 'pdf') {
    const result = await parsePDF(buffer);
    return {
      units: result.units,
      statedUnitCount: result.statedUnitCount,
      statedSummaryStats: result.statedSummaryStats,
      propertyName: result.propertyName,
      sourceType: 'pdf',
      sourceFormat: result.format,
      pageCount: result.pageCount,
      modelUsed: result.modelUsed,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
    };
  }

  throw new Error(`Unsupported file type: ${extension}`);
}

export { parseExcel } from './excel';
export { parsePDF } from './pdf';
