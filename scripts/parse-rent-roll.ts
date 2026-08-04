/**
 * CLI entry point for the full rent roll extraction pipeline — the same
 * parse → stats → validation → verification → explanation flow the web app's
 * background job runs, for use outside the app (Claude skill, scripting).
 *
 * Usage:
 *   npx tsx scripts/parse-rent-roll.ts <file.xlsx|file.pdf> [--out <path>] [--json]
 *
 *   --out <path>  Where to write the full extraction JSON
 *                 (default: alongside the input as <file>.extraction.json)
 *   --json        Print the full extraction JSON to stdout instead of the
 *                 human-readable summary
 *
 * Progress streams to stderr; the result summary (or --json payload) goes to
 * stdout. Exits non-zero on parse failure. Requires ANTHROPIC_API_KEY (read
 * from the repo's .env.local if not already in the environment).
 */
import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';

dotenv.config({ path: path.join(__dirname, '..', '.env.local') });

import { parseRentRoll } from '../src/lib/parsers';
import { validateExtraction } from '../src/lib/validation/validators';
import { runVerificationChecks } from '../src/lib/validation/verification';
import { explainMismatches } from '../src/lib/validation/explainer';
import { calculateSummaryStats } from '../src/lib/utils/summaryStats';
import { classifyChargeCodes, collectChargeCodes } from '../src/lib/utils/chargeClassifier';
import { estimateCostUSD, formatUSD } from '../src/lib/utils/aiCost';
import type { AIUsage } from '../src/lib/parsers/aiClient';
import type { ProgressEvent } from '../src/lib/types';

function usage(): never {
  console.error('Usage: npx tsx scripts/parse-rent-roll.ts <file.xlsx|file.pdf> [--out <path>] [--json]');
  process.exit(2);
}

async function main() {
  const args = process.argv.slice(2);
  const outIdx = args.indexOf('--out');
  const outArg = outIdx !== -1 ? args[outIdx + 1] : null;
  const asJson = args.includes('--json');
  const file = args.find((a, i) => !a.startsWith('--') && !(outIdx !== -1 && i === outIdx + 1));
  if (!file) usage();

  const filePath = path.resolve(file);
  if (!fs.existsSync(filePath)) {
    console.error(`File not found: ${filePath}`);
    process.exit(2);
  }
  const outPath = outArg
    ? path.resolve(outArg)
    : filePath.replace(/(\.[^.]+)?$/, '.extraction.json');

  const startTime = Date.now();
  const events: ProgressEvent[] = [];
  let lastHeartbeat = 0;
  const report = (stage: string, detail?: string, event?: Pick<ProgressEvent, 'kind' | 'message'>) => {
    const elapsed = `${Math.floor((Date.now() - startTime) / 1000)}s`;
    if (event) {
      events.push({ ...event, at: new Date().toISOString() });
      console.error(`[${elapsed}] ${event.message}`);
    } else if (detail && Date.now() - lastHeartbeat >= 15000) {
      // Heartbeats arrive every ~3s; sample them so long extractions stay readable
      lastHeartbeat = Date.now();
      console.error(`[${elapsed}] … ${detail}`);
    }
  };

  console.error(`Parsing ${path.basename(filePath)} (${Math.round(fs.statSync(filePath).size / 1024)}KB)`);
  const result = await parseRentRoll(fs.readFileSync(filePath), path.basename(filePath), report);

  // Categorize this document's own charge-code vocabulary before aggregating
  // (see utils/chargeClassifier.ts). One small call over the distinct codes.
  const postUsages: AIUsage[] = [];
  const chargeCodes = collectChargeCodes(result.units);
  if (chargeCodes.length > 0) {
    console.error(`[${Math.floor((Date.now() - startTime) / 1000)}s] Categorizing ${chargeCodes.length} distinct charge code(s)`);
    await classifyChargeCodes(result.units, postUsages);
  }

  const calculatedStats = calculateSummaryStats(result.units);
  const validationIssues = validateExtraction(
    result.units, result.statedUnitCount, result.statedSummaryStats, calculatedStats
  );
  const verificationSummary = runVerificationChecks(
    result.units, result.statedUnitCount, result.statedSummaryStats, calculatedStats
  );
  const failedChecks = verificationSummary.checks.filter(c => c.status === 'failed');
  if (failedChecks.length > 0) {
    console.error(`[${Math.floor((Date.now() - startTime) / 1000)}s] ${failedChecks.length} verification check(s) failed — asking AI to explain the mismatch`);
  }
  const explanationSummary = await explainMismatches(
    result.units, result.statedSummaryStats, calculatedStats, failedChecks, postUsages
  );
  const postCost = estimateCostUSD(postUsages);
  const costUSD = result.costUSD !== null || postCost !== null
    ? (result.costUSD ?? 0) + (postCost ?? 0)
    : null;

  const extraction = {
    fileName: path.basename(filePath),
    propertyName: result.propertyName,
    parsedAt: new Date().toISOString(),
    processingTimeMs: Date.now() - startTime,
    sourceFormat: result.sourceFormat,
    pageCount: result.pageCount,
    modelUsed: result.modelUsed,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    costUSD,
    statedUnitCount: result.statedUnitCount,
    extractedUnitCount: result.units.length,
    countMatch: result.statedUnitCount !== null ? result.units.length === result.statedUnitCount : null,
    units: result.units,
    summaryStats: calculatedStats,
    statedSummaryStats: result.statedSummaryStats,
    validationIssues,
    verificationSummary,
    explanationSummary,
    extractionLog: events,
  };

  fs.writeFileSync(outPath, JSON.stringify(extraction, null, 2));
  console.error(`\nFull extraction written to ${outPath}`);

  if (asJson) {
    console.log(JSON.stringify(extraction, null, 2));
    return;
  }

  const s = calculatedStats;
  const fmt = (n: number | null) => (n === null ? '—' : n.toLocaleString('en-US'));
  const lines = [
    `# ${result.propertyName ?? path.basename(filePath)}`,
    '',
    `- **Units extracted:** ${result.units.length}${result.statedUnitCount !== null ? ` (document states ${result.statedUnitCount})` : ''}`,
    `- **Status breakdown:** ${s.occupiedUnits} occupied, ${s.vacantUnits} vacant, ${s.noticeUnits} notice, ${s.applicantUnits} applicant, ${s.modelUnits} model, ${s.downUnits} down`,
    `- **Physical occupancy:** ${s.physicalOccupancy !== null ? s.physicalOccupancy.toFixed(1) + '%' : '—'}`,
    `- **Total monthly rent:** $${fmt(s.totalMonthlyRent)}${s.totalSqft ? `  |  **Total sqft:** ${fmt(s.totalSqft)}` : ''}`,
    ...((s.totalMarketRent ?? null) !== null || (s.totalSubsidyRent ?? null) !== null || (s.totalConcessions ?? null) !== null || (s.totalEmployeeDiscount ?? null) !== null
      ? [`- **Rent components:** ${[
          (s.totalMarketRent ?? null) !== null ? `market $${fmt(s.totalMarketRent!)}` : null,
          (s.totalSubsidyRent ?? null) !== null ? `subsidy $${fmt(s.totalSubsidyRent!)} (tenant-paid $${fmt(s.totalTenantPaidRent ?? null)})` : null,
          (s.totalEmployeeDiscount ?? null) !== null ? `employee discount $${fmt(s.totalEmployeeDiscount!)}` : null,
          (s.totalConcessions ?? null) !== null ? `concessions $${fmt(s.totalConcessions!)}` : null,
        ].filter(Boolean).join('  |  ')}`]
      : []),
    `- **Verification:** ${verificationSummary.passed}/${verificationSummary.total} checks passed${verificationSummary.skipped > 0 ? ` (${verificationSummary.skipped} skipped — no stated value in the document to check against)` : ''} — ${verificationSummary.confidence} confidence`,
    `- **Model:** ${result.modelUsed}  |  **Tokens:** ${fmt(result.inputTokens)} in / ${fmt(result.outputTokens)} out  |  **Est. cost:** ${formatUSD(costUSD)} (cache-aware)  |  **Time:** ${Math.round((Date.now() - startTime) / 1000)}s`,
  ];
  for (const check of failedChecks) {
    lines.push('', `## Failed check: ${check.name}`, check.details ?? '');
    const explanation = explanationSummary?.explanations?.find(e => e.checkId === check.id);
    if (explanation) {
      lines.push('', `**Explanation (${explanation.rootCause}):** ${explanation.explanation}`);
      if (explanation.recommendation) lines.push('', `**Recommendation:** ${explanation.recommendation}`);
    }
  }
  const criticalIssues = validationIssues.filter(i => i.severity === 'critical');
  if (criticalIssues.length > 0) {
    lines.push('', '## Critical validation issues');
    for (const issue of criticalIssues) lines.push(`- ${issue.message}`);
  }
  console.log(lines.join('\n'));
}

main().catch(err => {
  console.error(`Extraction failed: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
