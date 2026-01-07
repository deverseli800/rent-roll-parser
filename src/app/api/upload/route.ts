import { NextRequest, NextResponse } from 'next/server';
import { v4 as uuidv4 } from 'uuid';
import { parseRentRoll } from '@/lib/parsers';
import { validateExtraction } from '@/lib/validation/validators';
import { runVerificationChecks } from '@/lib/validation/verification';
import { explainMismatches } from '@/lib/validation/explainer';
import { calculateSummaryStats } from '@/lib/utils/summaryStats';
import type { RentRollExtraction } from '@/lib/types';

export async function POST(request: NextRequest) {
  const startTime = Date.now();

  try {
    const formData = await request.formData();
    const file = formData.get('file') as File | null;

    if (!file) {
      return NextResponse.json(
        { error: 'No file provided' },
        { status: 400 }
      );
    }

    // Validate file type
    const fileName = file.name.toLowerCase();
    const validExtensions = ['.xlsx', '.xls', '.pdf'];
    const hasValidExtension = validExtensions.some(ext => fileName.endsWith(ext));

    if (!hasValidExtension) {
      return NextResponse.json(
        { error: 'Invalid file type. Please upload an Excel (.xlsx, .xls) or PDF file.' },
        { status: 400 }
      );
    }

    // Read file buffer
    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    // Create initial extraction record
    const id = uuidv4();
    const extraction: RentRollExtraction = {
      id,
      fileName: file.name,
      propertyName: null,
      uploadedAt: new Date().toISOString(),
      processedAt: null,
      status: 'processing',
      units: [],
      statedUnitCount: null,
      extractedUnitCount: 0,
      countMatch: null,
      summaryStats: null,
      statedSummaryStats: null,
      validationIssues: [],
      verificationSummary: null,
      explanationSummary: null,
      sourceType: fileName.endsWith('.pdf') ? 'pdf' : 'excel',
      sourceFormat: null,
      processingTimeMs: null,
      pageCount: null,
      modelUsed: null,
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
      error: null,
    };

    try {
      // Parse the file
      const result = await parseRentRoll(buffer, file.name);

      // Calculate summary stats
      const calculatedStats = calculateSummaryStats(result.units);

      // Run validation (including stated vs calculated comparison)
      const issues = validateExtraction(
        result.units,
        result.statedUnitCount,
        result.statedSummaryStats,
        calculatedStats
      );

      // Run verification checks
      const verificationSummary = runVerificationChecks(
        result.units,
        result.statedUnitCount,
        result.statedSummaryStats,
        calculatedStats
      );

      // Generate explanations for failed checks
      const failedChecks = verificationSummary.checks.filter(c => c.status === 'failed');
      const explanationSummary = await explainMismatches(
        result.units,
        result.statedSummaryStats,
        calculatedStats,
        failedChecks
      );

      // Update extraction with results
      extraction.units = result.units;
      extraction.statedUnitCount = result.statedUnitCount;
      extraction.statedSummaryStats = result.statedSummaryStats;
      extraction.extractedUnitCount = result.units.length;
      extraction.countMatch = result.statedUnitCount !== null
        ? result.units.length === result.statedUnitCount
        : null;
      extraction.propertyName = result.propertyName;
      extraction.sourceFormat = result.sourceFormat;
      extraction.pageCount = result.pageCount;
      extraction.validationIssues = issues;
      extraction.verificationSummary = verificationSummary;
      extraction.explanationSummary = explanationSummary;
      extraction.summaryStats = calculatedStats;
      extraction.processedAt = new Date().toISOString();
      extraction.processingTimeMs = Date.now() - startTime;
      extraction.status = issues.some(i => i.severity === 'critical') ? 'review' : 'review';
      // AI usage tracking
      extraction.modelUsed = result.modelUsed;
      extraction.inputTokens = result.inputTokens;
      extraction.outputTokens = result.outputTokens;
      extraction.totalTokens = result.inputTokens + result.outputTokens;

      // Return full extraction for client-side storage
      return NextResponse.json(extraction);
    } catch (parseError) {
      // Update extraction with error
      extraction.status = 'error';
      extraction.error = parseError instanceof Error
        ? parseError.message
        : 'Unknown parsing error';
      extraction.processedAt = new Date().toISOString();
      extraction.processingTimeMs = Date.now() - startTime;

      // Return full extraction with error for client-side storage
      return NextResponse.json(extraction, { status: 500 });
    }
  } catch (error) {
    console.error('Upload error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Upload failed' },
      { status: 500 }
    );
  }
}
