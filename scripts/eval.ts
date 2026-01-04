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
  'redacted-roll-1.pdf': 194, // Has duplicates, extracts 216 but stated is 194
  'redacted-roll-2.pdf': 55,
  'redacted-roll-6.xlsx': 266,
  'redacted-roll-5.xlsx': 102,
  'redacted-roll-3.xls': 392,
  'redacted-roll-4.pdf': 90,
  'Rent Roll.xlsx': 200,
  'redacted-roll-7.xlsx': 28, // No stated count in doc
  'redacted-roll-8.pdf': 75,
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

      console.log(`  ✓ Extracted ${result.units.length} units`);
      console.log(`  ✓ Stated count in doc: ${result.statedUnitCount ?? 'N/A'}`);
      console.log(`  ✓ Count match (stated): ${result.statedUnitCount !== null ? (result.units.length === result.statedUnitCount ? '✓ YES' : '✗ NO') : 'N/A'}`);
      if (expectedCount !== null) {
        console.log(`  ✓ Expected count: ${expectedCount} ${matchesExpected ? '✓ MATCH' : '✗ MISMATCH'}`);
      }
      console.log(`  ✓ Critical issues: ${criticalIssues}`);
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

  console.log('\n--- Results Table ---\n');
  console.log('File'.padEnd(45) + 'Units'.padStart(8) + 'Expected'.padStart(10) + 'Match'.padStart(8) + 'Time(ms)'.padStart(10));
  console.log('-'.repeat(81));

  for (const r of results) {
    const matchStr = r.countMatch === true ? '✓' : r.countMatch === false ? '✗' : '-';
    const expectedStr = r.expectedCount !== null ? String(r.expectedCount) : '-';
    console.log(
      r.file.substring(0, 44).padEnd(45) +
      String(r.unitCount).padStart(8) +
      expectedStr.padStart(10) +
      matchStr.padStart(8) +
      String(r.processingTimeMs).padStart(10)
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
