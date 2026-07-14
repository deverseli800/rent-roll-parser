import { NextRequest, NextResponse } from 'next/server';
import { v4 as uuidv4 } from 'uuid';
import { saveServerExtraction } from '@/lib/server/extractionStore';
import { startExtractionJob } from '@/lib/server/processExtraction';
import type { RentRollExtraction } from '@/lib/types';

/**
 * Async upload: validates the file, creates a 'processing' record, kicks off a
 * background extraction job, and returns immediately. Clients poll
 * GET /api/extraction/[id] for progress and the final result.
 */
export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const file = formData.get('file') as File | null;

    if (!file) {
      return NextResponse.json({ error: 'No file provided' }, { status: 400 });
    }

    const fileName = file.name.toLowerCase();
    const validExtensions = ['.xlsx', '.xls', '.xlsm', '.pdf'];
    if (!validExtensions.some(ext => fileName.endsWith(ext))) {
      return NextResponse.json(
        { error: 'Invalid file type. Please upload an Excel (.xlsx, .xls, .xlsm) or PDF file.' },
        { status: 400 }
      );
    }

    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

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
      progress: { stage: 'queued', detail: null, updatedAt: new Date().toISOString() },
    };

    saveServerExtraction(extraction);
    startExtractionJob(id, buffer, file.name);

    return NextResponse.json(extraction, { status: 202 });
  } catch (error) {
    console.error('Upload error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Upload failed' },
      { status: 500 }
    );
  }
}
