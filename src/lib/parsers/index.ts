import { parseExcelV2 } from './excelV2';
import { parsePDFV2 } from './pdfV2';
import { reviewUnitCategories } from '../utils/categoryClassifier';
import { estimateCostUSD } from '../utils/aiCost';
import type { AIUsage } from './aiClient';
import type { GenericRentRollUnit, StatedSummaryStats } from '../types';

export interface ParseResult {
  units: GenericRentRollUnit[];
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
  // Cache-aware estimated API cost across all calls (null if unpriceable)
  costUSD: number | null;
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
  const parsed = await parseByType(buffer, extension, report);

  // Category review runs HERE, outside the per-format parsers, because the two
  // paths arrive with unequal answers: the full-AI path classifies each row from
  // the document's own use labels, while the fast path only has a keyword prior
  // over the unit id (excelFastPath.ts `classifyCategory`), which cannot read a
  // convention like a non-applicable bed/bath field. Reviewing after extraction
  // gives every path the same second look, from the extracted rows rather than a
  // sampled window of the sheet. It is also inside parseRentRoll on purpose:
  // the eval harness calls this function, so the corpus grades this behaviour
  // instead of the prior alone (the charge classifier sits outside and is
  // therefore invisible to the eval — see its CALLERS note).
  const reviewUsages: AIUsage[] = [];
  try {
    const { reviewed, changed, declined } = await reviewUnitCategories(parsed.units, reviewUsages);
    if (reviewed > 0) {
      const summary = changed.length > 0
        ? `corrected ${changed.map(c => `${c.units.join('/')} ${c.from} → ${c.to} (${c.evidence})`).join('; ')}`
        : 'no corrections';
      report?.('validating', 'reviewing unit categories', {
        kind: 'info',
        message: `Reviewed ${reviewed} ambiguous row shape${reviewed === 1 ? '' : 's'} for residential/commercial classification — ${summary}${declined.length > 0 ? `; declined ${declined.length} ungrounded proposal${declined.length === 1 ? '' : 's'}` : ''}`,
      });
    }
  } catch (e) {
    // Never let the review fail a parse: the parser's labels remain valid.
    console.warn('[parseRentRoll] category review failed, keeping parser labels:', e instanceof Error ? e.message : e);
  }
  if (reviewUsages.length > 0) {
    const extra = reviewUsages.reduce(
      (a, u) => ({ input: a.input + u.inputTokens, output: a.output + u.outputTokens }),
      { input: 0, output: 0 }
    );
    const extraCost = estimateCostUSD(reviewUsages);
    parsed.inputTokens += extra.input;
    parsed.outputTokens += extra.output;
    parsed.costUSD = parsed.costUSD === null ? extraCost : parsed.costUSD + (extraCost ?? 0);
  }
  return parsed;
}

async function parseByType(
  buffer: Buffer,
  extension: string | undefined,
  report?: import('./extractionCore').ProgressReporter
): Promise<ParseResult> {
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
      costUSD: result.costUSD,
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
      costUSD: result.costUSD,
    };
  }

  throw new Error(`Unsupported file type: ${extension}`);
}

export { parseExcel } from './excel';
export { parsePDF } from './pdf';
