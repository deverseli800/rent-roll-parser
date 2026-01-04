import { NextRequest, NextResponse } from 'next/server';
import { v4 as uuidv4 } from 'uuid';
import { parseRentRoll } from '@/lib/parsers';
import { validateExtraction } from '@/lib/validation/validators';
import { saveExtraction } from '@/lib/storage';
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
      validationIssues: [],
      sourceType: fileName.endsWith('.pdf') ? 'pdf' : 'excel',
      sourceFormat: null,
      processingTimeMs: null,
      pageCount: null,
      error: null,
    };

    // Save initial record
    await saveExtraction(extraction);

    try {
      // Parse the file
      const result = await parseRentRoll(buffer, file.name);

      // Run validation
      const issues = validateExtraction(result.units, result.statedUnitCount);

      // Update extraction with results
      extraction.units = result.units;
      extraction.statedUnitCount = result.statedUnitCount;
      extraction.extractedUnitCount = result.units.length;
      extraction.countMatch = result.statedUnitCount !== null
        ? result.units.length === result.statedUnitCount
        : null;
      extraction.propertyName = result.propertyName;
      extraction.sourceFormat = result.sourceFormat;
      extraction.pageCount = result.pageCount;
      extraction.validationIssues = issues;
      extraction.summaryStats = calculateSummaryStats(result.units);
      extraction.processedAt = new Date().toISOString();
      extraction.processingTimeMs = Date.now() - startTime;
      extraction.status = issues.some(i => i.severity === 'critical') ? 'review' : 'review';

      await saveExtraction(extraction);

      return NextResponse.json({
        id: extraction.id,
        status: extraction.status,
        extractedUnitCount: extraction.extractedUnitCount,
        statedUnitCount: extraction.statedUnitCount,
        countMatch: extraction.countMatch,
        criticalIssues: issues.filter(i => i.severity === 'critical').length,
        processingTimeMs: extraction.processingTimeMs,
      });
    } catch (parseError) {
      // Update extraction with error
      extraction.status = 'error';
      extraction.error = parseError instanceof Error
        ? parseError.message
        : 'Unknown parsing error';
      extraction.processedAt = new Date().toISOString();
      extraction.processingTimeMs = Date.now() - startTime;

      await saveExtraction(extraction);

      return NextResponse.json({
        id: extraction.id,
        status: 'error',
        error: extraction.error,
      }, { status: 500 });
    }
  } catch (error) {
    console.error('Upload error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Upload failed' },
      { status: 500 }
    );
  }
}
