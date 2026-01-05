import type { MVPUnit, ValidationIssue, StatedSummaryStats, SummaryStats } from '../types';

/**
 * MVP Validation - Focused on unit count accuracy
 * These validators ensure we don't miss units or hallucinate extras
 */

/**
 * Detect duplicate unit numbers
 */
export function detectDuplicates(units: MVPUnit[]): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const seen = new Map<string, number[]>();

  units.forEach((unit, index) => {
    const normalized = unit.unitNumber.trim().toUpperCase();
    if (!seen.has(normalized)) {
      seen.set(normalized, []);
    }
    seen.get(normalized)!.push(index);
  });

  for (const [unitNumber, indices] of seen) {
    if (indices.length > 1) {
      issues.push({
        type: 'duplicate',
        severity: 'critical',
        message: `Unit "${unitNumber}" appears ${indices.length} times (rows: ${indices.map(i => i + 1).join(', ')})`,
        unitNumbers: [unitNumber],
        details: { indices },
      });
    }
  }

  return issues;
}

/**
 * Detect gaps in sequential unit numbers
 * Only flags gaps when there's a clear sequential pattern (>80% consecutive)
 * Many buildings intentionally skip numbers, so we're conservative here
 */
export function detectGaps(units: MVPUnit[]): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  // Extract numeric portions of unit numbers
  const numericUnits: { original: string; numeric: number; prefix: string }[] = [];

  for (const unit of units) {
    // Match patterns like "101", "A-101", "1A", "101A"
    const match = unit.unitNumber.match(/^([A-Za-z\-]*)?(\d+)([A-Za-z]*)$/);
    if (match) {
      numericUnits.push({
        original: unit.unitNumber,
        numeric: parseInt(match[2], 10),
        prefix: match[1] || '',
      });
    }
  }

  // Group by prefix and check for gaps
  const byPrefix = new Map<string, number[]>();
  for (const unit of numericUnits) {
    if (!byPrefix.has(unit.prefix)) {
      byPrefix.set(unit.prefix, []);
    }
    byPrefix.get(unit.prefix)!.push(unit.numeric);
  }

  for (const [prefix, numbers] of byPrefix) {
    if (numbers.length < 10) continue; // Need enough data to detect a reliable pattern

    const sorted = [...new Set(numbers)].sort((a, b) => a - b);
    const range = sorted[sorted.length - 1] - sorted[0] + 1;

    // Only check for gaps if the numbers are mostly consecutive (>80% density)
    // This avoids false positives for buildings with intentional gaps
    const density = sorted.length / range;
    if (density < 0.8) continue;

    // Check for simple gaps (consecutive numbers)
    let gapCount = 0;
    const maxGaps = 3; // Limit warnings to avoid overwhelming the user

    for (let i = 1; i < sorted.length && gapCount < maxGaps; i++) {
      const gap = sorted[i] - sorted[i - 1];
      // Flag gaps of 1 (missing single unit) - larger gaps may be intentional (different floors)
      if (gap === 2) {
        const missing = sorted[i - 1] + 1;
        const missingUnit = prefix ? `${prefix}${missing}` : `${missing}`;
        issues.push({
          type: 'gap',
          severity: 'info', // Downgraded to info since gaps are often intentional
          message: `Possible missing unit: ${missingUnit} (between ${prefix}${sorted[i - 1]} and ${prefix}${sorted[i]})`,
          unitNumbers: [missingUnit],
          details: { before: sorted[i - 1], after: sorted[i], prefix },
        });
        gapCount++;
      }
    }
  }

  return issues;
}

/**
 * Check for count mismatch between stated and extracted counts
 */
export function checkCountMismatch(
  extractedCount: number,
  statedCount: number | null
): ValidationIssue | null {
  if (statedCount === null) {
    return {
      type: 'count_mismatch',
      severity: 'warning',
      message: `Could not find stated unit count in document. Extracted ${extractedCount} units - please verify manually.`,
      details: { extractedCount, statedCount: null },
    };
  }

  if (extractedCount !== statedCount) {
    const diff = extractedCount - statedCount;
    const direction = diff > 0 ? 'more' : 'fewer';
    return {
      type: 'count_mismatch',
      severity: 'critical',
      message: `Count mismatch: Extracted ${extractedCount} units but document states ${statedCount} (${Math.abs(diff)} ${direction})`,
      details: { extractedCount, statedCount, difference: diff },
    };
  }

  return null;
}

/**
 * Check for units with missing unit numbers
 */
export function checkMissingUnitNumbers(units: MVPUnit[]): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  units.forEach((unit, index) => {
    if (!unit.unitNumber || unit.unitNumber.trim() === '') {
      issues.push({
        type: 'missing_unit_number',
        severity: 'critical',
        message: `Row ${index + 1} has no unit number`,
        details: { rowIndex: index, unit },
      });
    }
  });

  return issues;
}

/**
 * Check for suspicious patterns that might indicate extraction errors
 */
export function checkSuspiciousPatterns(units: MVPUnit[]): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  // Check for occupied units with no rent
  const occupiedNoRent = units.filter(
    u => u.status === 'occupied' && (u.monthlyRent === null || u.monthlyRent === 0)
  );
  if (occupiedNoRent.length > 0 && occupiedNoRent.length <= 3) {
    // Only flag if it's a few units (otherwise might be intentional like employee housing)
    issues.push({
      type: 'suspicious',
      severity: 'warning',
      message: `${occupiedNoRent.length} occupied unit(s) have no rent: ${occupiedNoRent.map(u => u.unitNumber).join(', ')}`,
      unitNumbers: occupiedNoRent.map(u => u.unitNumber),
    });
  }

  // Check for very high unit numbers that might indicate charge codes being counted as units
  const suspiciouslyHigh = units.filter(u => {
    const num = parseInt(u.unitNumber.replace(/\D/g, ''), 10);
    return num > 9000; // Charge codes often have high numbers
  });
  if (suspiciouslyHigh.length > 0) {
    issues.push({
      type: 'suspicious',
      severity: 'warning',
      message: `${suspiciouslyHigh.length} unit(s) have unusually high numbers (may be charge codes): ${suspiciouslyHigh.map(u => u.unitNumber).join(', ')}`,
      unitNumbers: suspiciouslyHigh.map(u => u.unitNumber),
    });
  }

  return issues;
}

/**
 * Compare stated summary stats from document against calculated values
 * Flag significant mismatches that may indicate extraction errors
 */
export function checkSummaryMismatch(
  statedStats: StatedSummaryStats | null,
  calculatedStats: SummaryStats | null
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  if (!statedStats || !calculatedStats) {
    return issues;
  }

  // Check total monthly rent mismatch (allow 1% tolerance for rounding)
  if (statedStats.totalMonthlyRent !== null && calculatedStats.totalMonthlyRent !== null && calculatedStats.totalMonthlyRent > 0) {
    const diff = Math.abs(statedStats.totalMonthlyRent - calculatedStats.totalMonthlyRent);
    const tolerance = statedStats.totalMonthlyRent * 0.01; // 1% tolerance
    if (diff > tolerance && diff > 1) { // Also ignore differences under $1
      issues.push({
        type: 'summary_mismatch',
        severity: 'warning',
        message: `Total rent mismatch: Document states $${statedStats.totalMonthlyRent.toLocaleString()} but calculated $${calculatedStats.totalMonthlyRent.toLocaleString()} (diff: $${diff.toFixed(2)})`,
        details: {
          field: 'totalMonthlyRent',
          stated: statedStats.totalMonthlyRent,
          calculated: calculatedStats.totalMonthlyRent,
          difference: diff,
        },
      });
    }
  }

  // Check total sqft mismatch (allow 1% tolerance)
  if (statedStats.totalSqft !== null && calculatedStats.totalSqft !== null && calculatedStats.totalSqft > 0) {
    const diff = Math.abs(statedStats.totalSqft - calculatedStats.totalSqft);
    const tolerance = statedStats.totalSqft * 0.01;
    if (diff > tolerance && diff > 10) { // Ignore differences under 10 sqft
      issues.push({
        type: 'summary_mismatch',
        severity: 'warning',
        message: `Total sqft mismatch: Document states ${statedStats.totalSqft.toLocaleString()} but calculated ${calculatedStats.totalSqft.toLocaleString()} (diff: ${diff})`,
        details: {
          field: 'totalSqft',
          stated: statedStats.totalSqft,
          calculated: calculatedStats.totalSqft,
          difference: diff,
        },
      });
    }
  }

  // Check occupied unit count mismatch
  if (statedStats.occupiedUnits !== null) {
    if (statedStats.occupiedUnits !== calculatedStats.occupiedUnits) {
      issues.push({
        type: 'summary_mismatch',
        severity: 'warning',
        message: `Occupied count mismatch: Document states ${statedStats.occupiedUnits} but extracted ${calculatedStats.occupiedUnits}`,
        details: {
          field: 'occupiedUnits',
          stated: statedStats.occupiedUnits,
          calculated: calculatedStats.occupiedUnits,
          difference: statedStats.occupiedUnits - calculatedStats.occupiedUnits,
        },
      });
    }
  }

  // Check vacant unit count mismatch
  if (statedStats.vacantUnits !== null) {
    if (statedStats.vacantUnits !== calculatedStats.vacantUnits) {
      issues.push({
        type: 'summary_mismatch',
        severity: 'warning',
        message: `Vacant count mismatch: Document states ${statedStats.vacantUnits} but extracted ${calculatedStats.vacantUnits}`,
        details: {
          field: 'vacantUnits',
          stated: statedStats.vacantUnits,
          calculated: calculatedStats.vacantUnits,
          difference: statedStats.vacantUnits - calculatedStats.vacantUnits,
        },
      });
    }
  }

  // Check occupancy rate mismatch (allow 1% tolerance)
  if (statedStats.occupancyRate !== null && calculatedStats.physicalOccupancy !== null && calculatedStats.physicalOccupancy > 0) {
    const diff = Math.abs(statedStats.occupancyRate - calculatedStats.physicalOccupancy);
    if (diff > 1) { // More than 1% difference
      issues.push({
        type: 'summary_mismatch',
        severity: 'info',
        message: `Occupancy rate mismatch: Document states ${statedStats.occupancyRate.toFixed(1)}% but calculated ${calculatedStats.physicalOccupancy.toFixed(1)}%`,
        details: {
          field: 'occupancyRate',
          stated: statedStats.occupancyRate,
          calculated: calculatedStats.physicalOccupancy,
          difference: diff,
        },
      });
    }
  }

  return issues;
}

/**
 * Run all MVP validations
 */
export function validateExtraction(
  units: MVPUnit[],
  statedCount: number | null,
  statedStats?: StatedSummaryStats | null,
  calculatedStats?: SummaryStats | null
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  // Critical validations first
  issues.push(...checkMissingUnitNumbers(units));
  issues.push(...detectDuplicates(units));

  const countIssue = checkCountMismatch(units.length, statedCount);
  if (countIssue) {
    issues.push(countIssue);
  }

  // Warning-level validations
  issues.push(...detectGaps(units));
  issues.push(...checkSuspiciousPatterns(units));

  // Summary stat validations
  if (statedStats && calculatedStats) {
    issues.push(...checkSummaryMismatch(statedStats, calculatedStats));
  }

  // Sort by severity (critical first)
  const severityOrder = { critical: 0, warning: 1, info: 2 };
  issues.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);

  return issues;
}
