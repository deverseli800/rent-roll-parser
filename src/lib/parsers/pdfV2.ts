import type Anthropic from '@anthropic-ai/sdk';
import type { GenericRentRollUnit, StatedSummaryStats } from '../types';
import { sumUsage, type AIUsage } from './aiClient';
import { estimateCostUSD } from '../utils/aiCost';
import {
  EXTRACTION_RULES,
  extractStatedPreview,
  runExtractionLadder,
  toGenericRentRollUnits,
  toStatedSummaryStats,
  type ChunkingOptions,
  type ProgressReporter,
} from './extractionCore';

/** Count pages by scanning for page objects; null when the structure is
 * unrecognizable (compressed object streams) — chunking is skipped then. */
function detectPageCount(buffer: Buffer): number | null {
  const matches = buffer.toString('latin1').match(/\/Type\s*\/Page[^s]/g);
  return matches && matches.length > 0 ? matches.length : null;
}

/**
 * PDF parser v2.
 *
 * Sends the PDF to Claude vision with structured outputs (works for both
 * text PDFs and scans). Self-verifies against totals stated in the document;
 * escalates to stronger models with feedback when verification fails.
 */

const PDF_PROMPT = `${EXTRACTION_RULES}

Additional guidance for PDFs:
- Read EVERY page. Units often continue across page boundaries — do not stop at the first summary block if more unit sections follow.
- If the document is a scan/photo, transcribe carefully; double-check digits in rent amounts and unit numbers.
- If the document combines a rent roll with other content (operating statement, arrears ledger, I&E), extract ONLY the rent roll units; expense/income statement lines are not units.
- Reports with per-unit charge line items (RENT, SEC8, PREF, PARKING...): the unit's monthlyRent is its primary monthly rent charge (codes like rent/comm/vacant), not the sum of all charges.`;

export async function parsePDFV2(buffer: Buffer, report?: ProgressReporter): Promise<{
  units: GenericRentRollUnit[];
  statedUnitCount: number | null;
  statedSummaryStats: StatedSummaryStats | null;
  propertyName: string | null;
  format: string;
  pageCount: number | null;
  modelUsed: string;
  inputTokens: number;
  outputTokens: number;
  costUSD: number | null;
}> {
  const usages: AIUsage[] = [];
  const base64PDF = buffer.toString('base64');
  report?.('reading', 'preparing PDF', {
    kind: 'info',
    message: `Sending the PDF (${Math.round(buffer.length / 1024)}KB) to vision extraction — works on scans as well as digital PDFs`,
  });

  // The PDF block leads and is cache-marked: the stated-summary preview call
  // writes the document into the prompt cache, and the full extraction (and
  // any same-model retries with feedback) read it at ~0.1x input price.
  const docBlocks: Anthropic.ContentBlockParam[] = [
    {
      type: 'document',
      source: { type: 'base64', media_type: 'application/pdf', data: base64PDF },
      cache_control: { type: 'ephemeral' },
    },
  ];
  const content = (feedback?: string): Anthropic.ContentBlockParam[] => [
    ...docBlocks,
    { type: 'text', text: feedback ? `${PDF_PROMPT}\n\n${feedback}` : PDF_PROMPT },
  ];

  // Phase 1: quick stated-summary read so the UI shows the document's own
  // totals within seconds. Phase 2: the full unit-level extraction ladder.
  const preview = await extractStatedPreview(docBlocks, usages, report, 'the PDF');

  // Chunked fallback for PDFs whose units don't fit in one 128K response:
  // the ladder retries the same model on page ranges and merges.
  const pageCount = detectPageCount(buffer);
  const chunking: ChunkingOptions | undefined =
    pageCount !== null && pageCount >= 2
      ? {
          itemCount: pageCount,
          itemLabel: 'pages',
          estimatedUnits: preview?.statedUnitCount ?? null,
          makeChunkContent: ({ start, end, index, total }, feedback) => [
            ...docBlocks,
            {
              type: 'text',
              text:
                `${PDF_PROMPT}\n\nCHUNK SCOPE (chunk ${index} of ${total}): this ${pageCount}-page PDF is being extracted in ${total} page-range chunks because it is too large for one response. Extract ONLY the units whose row appears on pages ${start} through ${end} (inclusive, 1-based). Units on other pages are handled by other chunks — do NOT output them. A unit belongs to this chunk when the row bearing its unit number is in range; include its full details even if its charge rows continue onto the next page. Still report propertyName, statedTotalUnits, and statedSummary for the WHOLE document (they may appear on any page). The final recount rule applies only to unit rows on pages ${start}–${end}.` +
                (feedback ? `\n\n${feedback}` : ''),
            },
          ],
        }
      : undefined;

  const r = await runExtractionLadder(content, usages, report, 'PDF', chunking);
  const usage = sumUsage(usages);
  return {
    units: toGenericRentRollUnits(r.units, 1),
    statedUnitCount: r.statedTotalUnits ?? null,
    statedSummaryStats: toStatedSummaryStats(r),
    propertyName: r.propertyName ?? null,
    format: `ai-extraction-v2 (pdf, ${usages.length} attempt${usages.length === 1 ? '' : 's'})`,
    pageCount,
    modelUsed: usage.modelUsed,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    costUSD: estimateCostUSD(usages),
  };
}
