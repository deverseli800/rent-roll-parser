import { NextResponse } from 'next/server';
import { listExtractions } from '@/lib/storage';

export async function GET() {
  try {
    const extractions = await listExtractions();
    return NextResponse.json(extractions);
  } catch (error) {
    console.error('Error listing extractions:', error);
    return NextResponse.json(
      { error: 'Failed to list extractions' },
      { status: 500 }
    );
  }
}
