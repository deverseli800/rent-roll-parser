import { parseExcelV2 } from './excelV2';
import { parsePDFV2 } from './pdfV2';
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
  fileName: string,
  report?: import('./extractionCore').ProgressReporter
): Promise<ParseResult> {
  const extension = fileName.toLowerCase().split('.').pop();

  if (extension === 'xlsx' || extension === 'xls' || extension === 'xlsm') {
    const result = await parseExcelV2(buffer, report);
    return {
      units: result.units,
      statedUnitCount: result.statedUnitCount,
      statedSummaryStats: result.statedSummaryStats,
      propertyName: result.propertyName,
      sourceType: 'excel',
      sourceFormat: result.format,
      pageCount: null,
      modelUsed: result.modelUsed,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
    };
  }

  if (extension === 'pdf') {
    const result = await parsePDFV2(buffer, report);
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
