import { promises as fs } from 'fs';
import path from 'path';
import type { RentRollExtraction, ExtractionSummary } from './types';

const DATA_DIR = path.join(process.cwd(), 'data', 'extractions');

// Ensure data directory exists
async function ensureDataDir(): Promise<void> {
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
  } catch {
    // Directory already exists
  }
}

export async function saveExtraction(extraction: RentRollExtraction): Promise<void> {
  await ensureDataDir();
  const filePath = path.join(DATA_DIR, `${extraction.id}.json`);
  await fs.writeFile(filePath, JSON.stringify(extraction, null, 2), 'utf-8');
}

export async function getExtraction(id: string): Promise<RentRollExtraction | null> {
  try {
    const filePath = path.join(DATA_DIR, `${id}.json`);
    const content = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(content) as RentRollExtraction;
  } catch {
    return null;
  }
}

export async function updateExtraction(
  id: string,
  updates: Partial<RentRollExtraction>
): Promise<RentRollExtraction | null> {
  const existing = await getExtraction(id);
  if (!existing) return null;

  const updated = { ...existing, ...updates };
  await saveExtraction(updated);
  return updated;
}

export async function deleteExtraction(id: string): Promise<boolean> {
  try {
    const filePath = path.join(DATA_DIR, `${id}.json`);
    await fs.unlink(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function listExtractions(): Promise<ExtractionSummary[]> {
  await ensureDataDir();

  try {
    const files = await fs.readdir(DATA_DIR);
    const jsonFiles = files.filter(f => f.endsWith('.json'));

    const summaries: ExtractionSummary[] = [];

    for (const file of jsonFiles) {
      try {
        const filePath = path.join(DATA_DIR, file);
        const content = await fs.readFile(filePath, 'utf-8');
        const extraction = JSON.parse(content) as RentRollExtraction;

        summaries.push({
          id: extraction.id,
          fileName: extraction.fileName,
          propertyName: extraction.propertyName,
          status: extraction.status,
          extractedUnitCount: extraction.extractedUnitCount,
          statedUnitCount: extraction.statedUnitCount,
          countMatch: extraction.countMatch,
          criticalIssues: extraction.validationIssues.filter(i => i.severity === 'critical').length,
          uploadedAt: extraction.uploadedAt,
        });
      } catch {
        // Skip invalid files
      }
    }

    // Sort by upload date, newest first
    return summaries.sort((a, b) =>
      new Date(b.uploadedAt).getTime() - new Date(a.uploadedAt).getTime()
    );
  } catch {
    return [];
  }
}

// Save uploaded file temporarily for processing
export async function saveUploadedFile(
  fileName: string,
  buffer: Buffer
): Promise<string> {
  const uploadsDir = path.join(process.cwd(), 'data', 'uploads');
  await fs.mkdir(uploadsDir, { recursive: true });

  const uniqueName = `${Date.now()}-${fileName}`;
  const filePath = path.join(uploadsDir, uniqueName);
  await fs.writeFile(filePath, buffer);

  return filePath;
}

export async function deleteUploadedFile(filePath: string): Promise<void> {
  try {
    await fs.unlink(filePath);
  } catch {
    // File may already be deleted
  }
}

export async function readUploadedFile(filePath: string): Promise<Buffer> {
  return fs.readFile(filePath);
}
