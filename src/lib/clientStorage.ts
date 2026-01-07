// Client-side storage for extractions using localStorage
import type { RentRollExtraction, ExtractionSummary } from './types';

const STORAGE_KEY = 'rent-roll-extractions';

// Get all extractions from localStorage
export function getStoredExtractions(): RentRollExtraction[] {
  if (typeof window === 'undefined') return [];

  try {
    const data = localStorage.getItem(STORAGE_KEY);
    if (!data) return [];
    return JSON.parse(data) as RentRollExtraction[];
  } catch {
    console.error('Failed to parse stored extractions');
    return [];
  }
}

// Save an extraction to localStorage
export function saveExtraction(extraction: RentRollExtraction): void {
  if (typeof window === 'undefined') return;

  const extractions = getStoredExtractions();
  const existingIndex = extractions.findIndex(e => e.id === extraction.id);

  if (existingIndex >= 0) {
    extractions[existingIndex] = extraction;
  } else {
    extractions.unshift(extraction); // Add to beginning (newest first)
  }

  localStorage.setItem(STORAGE_KEY, JSON.stringify(extractions));
}

// Get a single extraction by ID
export function getExtraction(id: string): RentRollExtraction | null {
  const extractions = getStoredExtractions();
  return extractions.find(e => e.id === id) || null;
}

// Update an extraction
export function updateExtraction(
  id: string,
  updates: Partial<RentRollExtraction>
): RentRollExtraction | null {
  const extractions = getStoredExtractions();
  const index = extractions.findIndex(e => e.id === id);

  if (index < 0) return null;

  extractions[index] = { ...extractions[index], ...updates };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(extractions));

  return extractions[index];
}

// Delete an extraction
export function deleteExtraction(id: string): boolean {
  const extractions = getStoredExtractions();
  const filtered = extractions.filter(e => e.id !== id);

  if (filtered.length === extractions.length) return false;

  localStorage.setItem(STORAGE_KEY, JSON.stringify(filtered));
  return true;
}

// Get extraction summaries for the list view
export function getExtractionSummaries(): ExtractionSummary[] {
  const extractions = getStoredExtractions();

  return extractions.map(e => ({
    id: e.id,
    fileName: e.fileName,
    propertyName: e.propertyName,
    status: e.status,
    extractedUnitCount: e.extractedUnitCount,
    statedUnitCount: e.statedUnitCount,
    countMatch: e.countMatch,
    criticalIssues: e.validationIssues.filter(i => i.severity === 'critical').length,
    uploadedAt: e.uploadedAt,
    processingTimeMs: e.processingTimeMs,
    error: e.error,
    modelUsed: e.modelUsed ?? null,
    totalTokens: e.totalTokens ?? null,
    verificationPassed: e.verificationSummary?.passed ?? null,
    verificationFailed: e.verificationSummary?.failed ?? null,
    verificationSkipped: e.verificationSummary?.skipped ?? null,
    verificationConfidence: e.verificationSummary?.confidence ?? null,
  }));
}
