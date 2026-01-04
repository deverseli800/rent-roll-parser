import { NextRequest, NextResponse } from 'next/server';
import { getExtraction, updateExtraction, deleteExtraction } from '@/lib/storage';
import { validateExtraction } from '@/lib/validation/validators';
import { calculateSummaryStats } from '@/lib/utils/summaryStats';
import type { MVPUnit } from '@/lib/types';

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function GET(
  request: NextRequest,
  { params }: RouteParams
) {
  const { id } = await params;

  try {
    const extraction = await getExtraction(id);

    if (!extraction) {
      return NextResponse.json(
        { error: 'Extraction not found' },
        { status: 404 }
      );
    }

    return NextResponse.json(extraction);
  } catch (error) {
    console.error('Error getting extraction:', error);
    return NextResponse.json(
      { error: 'Failed to get extraction' },
      { status: 500 }
    );
  }
}

export async function PUT(
  request: NextRequest,
  { params }: RouteParams
) {
  const { id } = await params;

  try {
    const body = await request.json();
    const { units, status } = body as {
      units?: MVPUnit[];
      status?: 'review' | 'approved';
    };

    const extraction = await getExtraction(id);
    if (!extraction) {
      return NextResponse.json(
        { error: 'Extraction not found' },
        { status: 404 }
      );
    }

    const updates: Record<string, unknown> = {};

    if (units) {
      // Re-run validation with updated units
      const issues = validateExtraction(units, extraction.statedUnitCount);
      updates.units = units;
      updates.extractedUnitCount = units.length;
      updates.countMatch = extraction.statedUnitCount !== null
        ? units.length === extraction.statedUnitCount
        : null;
      updates.validationIssues = issues;
      // Recalculate summary stats
      updates.summaryStats = calculateSummaryStats(units);
    }

    if (status) {
      updates.status = status;
    }

    const updated = await updateExtraction(id, updates);
    return NextResponse.json(updated);
  } catch (error) {
    console.error('Error updating extraction:', error);
    return NextResponse.json(
      { error: 'Failed to update extraction' },
      { status: 500 }
    );
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: RouteParams
) {
  const { id } = await params;

  try {
    const deleted = await deleteExtraction(id);

    if (!deleted) {
      return NextResponse.json(
        { error: 'Extraction not found' },
        { status: 404 }
      );
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Error deleting extraction:', error);
    return NextResponse.json(
      { error: 'Failed to delete extraction' },
      { status: 500 }
    );
  }
}
