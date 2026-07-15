import { parseRentRoll } from '../parsers';
import { validateExtraction } from '../validation/validators';
import { runVerificationChecks } from '../validation/verification';
import { explainMismatches } from '../validation/explainer';
import { calculateSummaryStats } from '../utils/summaryStats';
import { updateServerExtraction } from './extractionStore';
import type { ProgressEvent } from '../types';

// Timeline safety cap — a pathological document can't grow the record unboundedly.
const MAX_EVENTS = 100;

/**
 * Background extraction job. Runs in the Next.js server process after
 * /api/upload has already responded; writes progress and the final result to
 * the server-side store, which the client polls via GET /api/extraction/[id].
 */
export function startExtractionJob(id: string, buffer: Buffer, fileName: string): void {
  // Fire and forget — deliberately not awaited by the upload route.
  void runJob(id, buffer, fileName);
}

async function runJob(id: string, buffer: Buffer, fileName: string): Promise<void> {
  const startTime = Date.now();

  // Throttle heartbeat writes to one per second, but always write stage
  // changes and timeline events (users watch these live).
  let lastWrite = 0;
  let lastStage = '';
  let lastDetail: string | null = null;
  const events: ProgressEvent[] = [];
  const report = (stage: string, detail?: string, event?: Pick<ProgressEvent, 'kind' | 'message'>) => {
    const now = Date.now();
    if (event && events.length < MAX_EVENTS) {
      events.push({ ...event, at: new Date().toISOString() });
    }
    if (!event && stage === lastStage && now - lastWrite < 1000) return;
    lastWrite = now;
    lastStage = stage;
    if (detail !== undefined) lastDetail = detail;
    updateServerExtraction(id, {
      progress: {
        stage,
        // Events often come without a detail (they ARE the news) — keep the
        // last activity line rather than blanking it.
        detail: detail ?? lastDetail,
        updatedAt: new Date().toISOString(),
        events: [...events],
      },
    });
  };

  try {
    const result = await parseRentRoll(buffer, fileName, report);

    report('validating', 'computing summary stats and validation checks', {
      kind: 'info',
      message: `Extraction complete — ${result.units.length} units. Running validation and verification checks`,
    });
    const calculatedStats = calculateSummaryStats(result.units);
    const issues = validateExtraction(
      result.units,
      result.statedUnitCount,
      result.statedSummaryStats,
      calculatedStats
    );
    const verificationSummary = runVerificationChecks(
      result.units,
      result.statedUnitCount,
      result.statedSummaryStats,
      calculatedStats
    );

    const failedChecks = verificationSummary.checks.filter(c => c.status === 'failed');
    lastWrite = 0;
    report('explaining', failedChecks.length > 0
      ? `analyzing ${failedChecks.length} failed verification check${failedChecks.length === 1 ? '' : 's'}`
      : 'finalizing',
      failedChecks.length > 0
        ? {
            kind: 'verify_fail',
            message: `${failedChecks.length} verification check${failedChecks.length === 1 ? '' : 's'} failed (${failedChecks.map(c => c.name).join(', ')}) — asking AI to explain the mismatch`,
          }
        : {
            kind: 'verify_pass',
            message: `All ${verificationSummary.passed} verifiable checks passed — ${verificationSummary.confidence} confidence`,
          });
    const explanationSummary = await explainMismatches(
      result.units,
      result.statedSummaryStats,
      calculatedStats,
      failedChecks
    );

    updateServerExtraction(id, {
      units: result.units,
      statedUnitCount: result.statedUnitCount,
      statedSummaryStats: result.statedSummaryStats,
      extractedUnitCount: result.units.length,
      countMatch: result.statedUnitCount !== null
        ? result.units.length === result.statedUnitCount
        : null,
      propertyName: result.propertyName,
      sourceFormat: result.sourceFormat,
      pageCount: result.pageCount,
      validationIssues: issues,
      verificationSummary,
      explanationSummary,
      summaryStats: calculatedStats,
      processedAt: new Date().toISOString(),
      processingTimeMs: Date.now() - startTime,
      status: 'review',
      modelUsed: result.modelUsed,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      totalTokens: result.inputTokens + result.outputTokens,
      progress: null,
      extractionLog: events,
    });
  } catch (error) {
    console.error(`[extraction ${id}] job failed:`, error);
    updateServerExtraction(id, {
      status: 'error',
      error: error instanceof Error ? error.message : 'Unknown parsing error',
      processedAt: new Date().toISOString(),
      processingTimeMs: Date.now() - startTime,
      progress: null,
      extractionLog: events,
    });
  }
}
