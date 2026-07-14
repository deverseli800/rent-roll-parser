import * as fs from 'fs';
import * as path from 'path';
import type { RentRollExtraction } from '../types';

/**
 * Server-side extraction persistence: one JSON file per extraction in
 * data/extractions/. Survives dev-server restarts; the client keeps its own
 * localStorage copy once processing completes (review edits stay client-side).
 */

const STORE_DIR = path.join(process.cwd(), 'data', 'extractions');

function filePath(id: string): string {
  // ids are uuids we generate; keep the guard anyway
  if (!/^[a-zA-Z0-9-]+$/.test(id)) throw new Error('Invalid extraction id');
  return path.join(STORE_DIR, `${id}.json`);
}

export function saveServerExtraction(extraction: RentRollExtraction): void {
  fs.mkdirSync(STORE_DIR, { recursive: true });
  const tmp = filePath(extraction.id) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(extraction, null, 2));
  fs.renameSync(tmp, filePath(extraction.id));
}

export function getServerExtraction(id: string): RentRollExtraction | null {
  try {
    const raw = fs.readFileSync(filePath(id), 'utf-8');
    return JSON.parse(raw) as RentRollExtraction;
  } catch {
    return null;
  }
}

export function updateServerExtraction(
  id: string,
  updates: Partial<RentRollExtraction>
): RentRollExtraction | null {
  const current = getServerExtraction(id);
  if (!current) return null;
  const next = { ...current, ...updates };
  saveServerExtraction(next);
  return next;
}

/**
 * If a processing record's heartbeat is stale (server restarted mid-job or the
 * job died without writing an error), surface it as an error so the client
 * stops polling forever.
 */
export function withStaleCheck(extraction: RentRollExtraction): RentRollExtraction {
  if (extraction.status !== 'processing') return extraction;
  const last = extraction.progress?.updatedAt ?? extraction.uploadedAt;
  const ageMs = Date.now() - new Date(last).getTime();
  if (ageMs > 10 * 60 * 1000) {
    const stale = updateServerExtraction(extraction.id, {
      status: 'error',
      error: 'Processing was interrupted (no progress for 10 minutes — the server may have restarted). Please re-upload the file.',
      processedAt: new Date().toISOString(),
      progress: null,
    });
    return stale ?? extraction;
  }
  return extraction;
}
