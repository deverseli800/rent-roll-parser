import { NextRequest, NextResponse } from 'next/server';
import { getServerExtraction, withStaleCheck } from '@/lib/server/extractionStore';

/**
 * Poll endpoint for background extraction jobs. Returns the current server-side
 * record, including live progress while status === 'processing'.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const extraction = getServerExtraction(id);
  if (!extraction) {
    return NextResponse.json({ error: 'Extraction not found' }, { status: 404 });
  }
  return NextResponse.json(withStaleCheck(extraction));
}
