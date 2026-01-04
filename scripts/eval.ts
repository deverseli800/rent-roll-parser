import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';

// Load environment variables from .env.local
dotenv.config({ path: path.join(__dirname, '..', '.env.local') });

import { parseRentRoll } from '../src/lib/parsers';
import { validateExtraction } from '../src/lib/validation/validators';
import { calculateSummaryStats } from '../src/lib/utils/summaryStats';

const SAMPLES_DIR = './data/sample-rolls';

// Expected unit counts for each sample file (based on stated counts in documents)
const EXPECTED_COUNTS: Record<string, number | null> = {
  '03.13.2025 UG Rent Roll Detail (1).pdf': 194, // Has duplicates, extracts 216 but stated is 194
  '2025_07 Holiday Apartments RR.pdf': 55,
  'Ellington Nov25 RR.xlsx': 266,
  'R72 Rent Roll 10.16.25 E.1019.25.xlsx': 102,
  'Rent Roll 12-15-2025--Vetra Asheville.xls': 392,
  'Rent Roll Crossings July 2025 1.pdf': 90,
  'Rent Roll.xlsx': 200,
  'UnitRentRoll12_08_2025.xlsx': 28, // No stated count in doc
  'rent_roll-11-30-25.pdf': 75,
};

async function runEval() {
  const files = fs.readdirSync(SAMPLES_DIR).filter(f =>
    f.endsWith('.pdf') || f.endsWith('.xlsx') || f.endsWith('.xls')
  ).filter(f => !f.startsWith('~$')); // Skip temp Excel files

  console.log(`\n${'='.repeat(80)}`);
  console.log('RENT ROLL PARSER EVALUATION');
  console.log(`${'='.repeat(80)}\n`);
  console.log(`Found ${files.length} sample files to test\n`);

  const results: Array<{
    file: string;
    success: boolean;
    unitCount: number;
    expectedCount: number | null;
    countMatch: boolean | null;
    statedCount: number | null;
    criticalIssues: number;
    processingTimeMs: number;
    modelUsed: string;
    totalTokens: number;
    error?: string;
  }> = [];

  for (const file of files) {
    const filePath = path.join(SAMPLES_DIR, file);
    console.log(`\n${'─'.repeat(60)}`);
    console.log(`Testing: ${file}`);
    console.log(`${'─'.repeat(60)}`);

    const startTime = Date.now();

    try {
      const buffer = fs.readFileSync(filePath);
      const result = await parseRentRoll(buffer, file);
      const processingTimeMs = Date.now() - startTime;

      const issues = validateExtraction(result.units, result.statedUnitCount);
      const stats = calculateSummaryStats(result.units);
      const criticalIssues = issues.filter(i => i.severity === 'critical').length;

      const expectedCount = EXPECTED_COUNTS[file];
      const matchesExpected = expectedCount !== null ? result.units.length === expectedCount : null;

      const totalTokens = result.inputTokens + result.outputTokens;
      const modelShort = result.modelUsed.includes('opus') ? 'Opus 4.5' :
                         result.modelUsed.includes('sonnet-4-5') ? 'Sonnet 4.5' :
                         result.modelUsed.includes('sonnet') ? 'Sonnet 4' : result.modelUsed;

      console.log(`  ✓ Extracted ${result.units.length} units`);
      console.log(`  ✓ Stated count in doc: ${result.statedUnitCount ?? 'N/A'}`);
      console.log(`  ✓ Count match (stated): ${result.statedUnitCount !== null ? (result.units.length === result.statedUnitCount ? '✓ YES' : '✗ NO') : 'N/A'}`);
      if (expectedCount !== null) {
        console.log(`  ✓ Expected count: ${expectedCount} ${matchesExpected ? '✓ MATCH' : '✗ MISMATCH'}`);
      }
      console.log(`  ✓ Critical issues: ${criticalIssues}`);
      console.log(`  ✓ Model: ${modelShort}`);
      console.log(`  ✓ Tokens: ${totalTokens.toLocaleString()} (in: ${result.inputTokens.toLocaleString()}, out: ${result.outputTokens.toLocaleString()})`);
      console.log(`  ✓ Processing time: ${processingTimeMs}ms`);

      // Show summary stats
      console.log(`  ✓ Occupancy breakdown: ${stats.occupiedUnits} occupied, ${stats.vacantUnits} vacant, ${stats.noticeUnits} notice`);
      if (stats.physicalOccupancy !== null) {
        console.log(`  ✓ Physical occupancy: ${stats.physicalOccupancy.toFixed(1)}%`);
      }

      results.push({
        file,
        success: true,
        unitCount: result.units.length,
        expectedCount,
        countMatch: matchesExpected,
        statedCount: result.statedUnitCount,
        criticalIssues,
        processingTimeMs,
        modelUsed: modelShort,
        totalTokens,
      });

    } catch (error) {
      const processingTimeMs = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.log(`  ✗ ERROR: ${errorMessage}`);

      results.push({
        file,
        success: false,
        unitCount: 0,
        expectedCount: EXPECTED_COUNTS[file],
        countMatch: null,
        statedCount: null,
        criticalIssues: 0,
        processingTimeMs,
        modelUsed: '—',
        totalTokens: 0,
        error: errorMessage,
      });
    }
  }

  // Summary
  console.log(`\n${'='.repeat(80)}`);
  console.log('EVALUATION SUMMARY');
  console.log(`${'='.repeat(80)}\n`);

  const successful = results.filter(r => r.success);
  const failed = results.filter(r => !r.success);
  const matchedExpected = results.filter(r => r.countMatch === true);
  const mismatchedExpected = results.filter(r => r.countMatch === false);

  console.log(`Total files: ${results.length}`);
  console.log(`Successful extractions: ${successful.length}`);
  console.log(`Failed extractions: ${failed.length}`);
  console.log(`Matched expected count: ${matchedExpected.length}`);
  console.log(`Mismatched expected count: ${mismatchedExpected.length}`);

  // Calculate total tokens used
  const totalTokensUsed = results.reduce((sum, r) => sum + r.totalTokens, 0);
  console.log(`\nTotal tokens used: ${totalTokensUsed.toLocaleString()}`);

  console.log('\n--- Results Table ---\n');
  console.log('File'.padEnd(40) + 'Units'.padStart(7) + 'Match'.padStart(7) + 'Model'.padStart(12) + 'Tokens'.padStart(10) + 'Time'.padStart(10));
  console.log('-'.repeat(86));

  for (const r of results) {
    const matchStr = r.countMatch === true ? '✓' : r.countMatch === false ? '✗' : '-';
    const tokensStr = r.totalTokens > 0 ? `${(r.totalTokens / 1000).toFixed(1)}k` : '-';
    const timeStr = r.processingTimeMs < 1000 ? `${r.processingTimeMs}ms` :
                    r.processingTimeMs < 60000 ? `${(r.processingTimeMs / 1000).toFixed(1)}s` :
                    `${(r.processingTimeMs / 60000).toFixed(1)}m`;
    console.log(
      r.file.substring(0, 39).padEnd(40) +
      String(r.unitCount).padStart(7) +
      matchStr.padStart(7) +
      r.modelUsed.padStart(12) +
      tokensStr.padStart(10) +
      timeStr.padStart(10)
    );
  }

  if (failed.length > 0) {
    console.log('\n--- Failed Files ---\n');
    for (const r of failed) {
      console.log(`${r.file}: ${r.error}`);
    }
  }

  if (mismatchedExpected.length > 0) {
    console.log('\n--- Mismatched Files ---\n');
    for (const r of mismatchedExpected) {
      console.log(`${r.file}: got ${r.unitCount}, expected ${r.expectedCount}`);
    }
  }

  console.log('\n');
}

runEval().catch(console.error);
