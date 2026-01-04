import { NextRequest, NextResponse } from 'next/server';
import { getExtraction } from '@/lib/storage';
import { exportToExcel } from '@/lib/export/excel';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const extraction = await getExtraction(id);

    if (!extraction) {
      return NextResponse.json(
        { error: 'Extraction not found' },
        { status: 404 }
      );
    }

    const buffer = exportToExcel(extraction);

    // Create filename from original file name
    const baseName = extraction.fileName.replace(/\.[^/.]+$/, '');
    const filename = `${baseName}_export.xlsx`;

    // Convert Buffer to Uint8Array for NextResponse
    const uint8Array = new Uint8Array(buffer);

    return new NextResponse(uint8Array, {
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="${filename}"`,
      },
    });
  } catch (error) {
    console.error('Error exporting extraction:', error);
    return NextResponse.json(
      { error: 'Failed to export extraction' },
      { status: 500 }
    );
  }
}
