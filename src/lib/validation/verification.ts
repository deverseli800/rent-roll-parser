import type {
  MVPUnit,
  StatedSummaryStats,
  SummaryStats,
  VerificationCheck,
  VerificationSummary,
} from '../types';

/**
 * Run all verification checks and return a summary
 * Similar to unit tests - each check passes, fails, or is skipped
 */
export function runVerificationChecks(
  units: MVPUnit[],
  statedUnitCount: number | null,
  statedStats: StatedSummaryStats | null,
  calculatedStats: SummaryStats | null
): VerificationSummary {
  const checks: VerificationCheck[] = [];

  // Check 1: Unit count matches stated count
  checks.push(checkUnitCount(units.length, statedUnitCount));

  // Check 2: No duplicate unit numbers
  checks.push(checkNoDuplicates(units));

  // Check 3: No missing unit numbers
  checks.push(checkNoMissingUnitNumbers(units));

  // Check 4: Total monthly rent matches
  checks.push(checkTotalRent(statedStats, calculatedStats));

  // Check 5: Occupied count matches
  checks.push(checkOccupiedCount(statedStats, calculatedStats));

  // Check 6: Vacant count matches
  checks.push(checkVacantCount(statedStats, calculatedStats));

  // Check 7: Total sqft matches
  checks.push(checkTotalSqft(statedStats, calculatedStats));

  // Calculate summary
  const passed = checks.filter(c => c.status === 'passed').length;
  const failed = checks.filter(c => c.status === 'failed').length;
  const skipped = checks.filter(c => c.status === 'skipped').length;
  const total = checks.length;

  // Determine confidence level and reason
  let confidence: 'high' | 'medium' | 'low';
  let confidenceReason: string;

  if (failed === 0 && skipped <= 2) {
    confidence = 'high';
    confidenceReason = 'All verifiable checks passed with sufficient stated values to compare against.';
  } else if (failed <= 1 && passed >= 3) {
    confidence = 'medium';
    if (failed === 1) {
      confidenceReason = `1 check failed but ${passed} checks passed. Review the failed check for potential issues.`;
    } else {
      confidenceReason = `${passed} checks passed but ${skipped} checks were skipped due to missing stated values.`;
    }
  } else {
    if (failed > 0) {
      confidenceReason = `${failed} check(s) failed. Review the extraction for potential errors.`;
    } else if (skipped > 2 && passed < 3) {
      confidenceReason = `Only ${passed} of ${total} checks could be verified. Document lacks stated summary values (unit count, totals, etc.) for comparison.`;
    } else {
      confidenceReason = `Insufficient verification: ${passed} passed, ${failed} failed, ${skipped} skipped.`;
    }
    confidence = 'low';
  }

  return {
    confidence,
    confidenceReason,
    passed,
    failed,
    skipped,
    total,
    checks,
  };
}

function checkUnitCount(
  extractedCount: number,
  statedCount: number | null
): VerificationCheck {
  if (statedCount === null) {
    return {
      id: 'unit-count',
      name: 'Unit Count',
      description: 'Extracted count matches stated count in document',
      status: 'skipped',
      details: 'No stated unit count found in document',
    };
  }

  if (extractedCount === statedCount) {
    return {
      id: 'unit-count',
      name: 'Unit Count',
      description: 'Extracted count matches stated count in document',
      status: 'passed',
      details: `${extractedCount} units extracted, matches stated count`,
    };
  }

  const diff = extractedCount - statedCount;
  return {
    id: 'unit-count',
    name: 'Unit Count',
    description: 'Extracted count matches stated count in document',
    status: 'failed',
    details: `Extracted ${extractedCount} but document states ${statedCount} (${diff > 0 ? '+' : ''}${diff})`,
  };
}

function checkNoDuplicates(units: MVPUnit[]): VerificationCheck {
  const seen = new Set<string>();
  const duplicates: string[] = [];

  for (const unit of units) {
    const normalized = unit.unitNumber.trim().toUpperCase();
    if (seen.has(normalized)) {
      duplicates.push(unit.unitNumber);
    }
    seen.add(normalized);
  }

  if (duplicates.length === 0) {
    return {
      id: 'no-duplicates',
      name: 'No Duplicates',
      description: 'All unit numbers are unique',
      status: 'passed',
      details: `${units.length} unique unit numbers`,
    };
  }

  return {
    id: 'no-duplicates',
    name: 'No Duplicates',
    description: 'All unit numbers are unique',
    status: 'failed',
    details: `Duplicate units found: ${duplicates.slice(0, 3).join(', ')}${duplicates.length > 3 ? ` (+${duplicates.length - 3} more)` : ''}`,
  };
}

function checkNoMissingUnitNumbers(units: MVPUnit[]): VerificationCheck {
  const missing = units.filter(u => !u.unitNumber || u.unitNumber.trim() === '');

  if (missing.length === 0) {
    return {
      id: 'no-missing-numbers',
      name: 'Unit Numbers Present',
      description: 'All units have unit numbers',
      status: 'passed',
      details: 'All units have valid unit numbers',
    };
  }

  return {
    id: 'no-missing-numbers',
    name: 'Unit Numbers Present',
    description: 'All units have unit numbers',
    status: 'failed',
    details: `${missing.length} unit(s) missing unit numbers`,
  };
}

function checkTotalRent(
  statedStats: StatedSummaryStats | null,
  calculatedStats: SummaryStats | null
): VerificationCheck {
  if (!statedStats?.totalMonthlyRent || !calculatedStats?.totalMonthlyRent) {
    return {
      id: 'total-rent',
      name: 'Total Rent',
      description: 'Calculated total matches stated total',
      status: 'skipped',
      details: 'No stated total rent in document',
    };
  }

  const stated = statedStats.totalMonthlyRent;
  const calculated = calculatedStats.totalMonthlyRent;
  const diff = Math.abs(stated - calculated);
  const tolerance = stated * 0.01; // 1% tolerance

  if (diff <= tolerance || diff <= 1) {
    return {
      id: 'total-rent',
      name: 'Total Rent',
      description: 'Calculated total matches stated total',
      status: 'passed',
      details: `$${calculated.toLocaleString()} matches stated $${stated.toLocaleString()}`,
    };
  }

  return {
    id: 'total-rent',
    name: 'Total Rent',
    description: 'Calculated total matches stated total',
    status: 'failed',
    details: `Calculated $${calculated.toLocaleString()} vs stated $${stated.toLocaleString()} (diff: $${diff.toFixed(2)})`,
  };
}

function checkOccupiedCount(
  statedStats: StatedSummaryStats | null,
  calculatedStats: SummaryStats | null
): VerificationCheck {
  if (statedStats?.occupiedUnits === null || statedStats?.occupiedUnits === undefined) {
    return {
      id: 'occupied-count',
      name: 'Occupied Count',
      description: 'Calculated occupied matches stated count',
      status: 'skipped',
      details: 'No stated occupied count in document',
    };
  }

  const stated = statedStats.occupiedUnits;
  const calculated = calculatedStats?.occupiedUnits ?? 0;

  if (stated === calculated) {
    return {
      id: 'occupied-count',
      name: 'Occupied Count',
      description: 'Calculated occupied matches stated count',
      status: 'passed',
      details: `${calculated} occupied units matches stated count`,
    };
  }

  return {
    id: 'occupied-count',
    name: 'Occupied Count',
    description: 'Calculated occupied matches stated count',
    status: 'failed',
    details: `Calculated ${calculated} vs stated ${stated}`,
  };
}

function checkVacantCount(
  statedStats: StatedSummaryStats | null,
  calculatedStats: SummaryStats | null
): VerificationCheck {
  if (statedStats?.vacantUnits === null || statedStats?.vacantUnits === undefined) {
    return {
      id: 'vacant-count',
      name: 'Vacant Count',
      description: 'Calculated vacant matches stated count',
      status: 'skipped',
      details: 'No stated vacant count in document',
    };
  }

  const stated = statedStats.vacantUnits;
  const calculated = calculatedStats?.vacantUnits ?? 0;

  if (stated === calculated) {
    return {
      id: 'vacant-count',
      name: 'Vacant Count',
      description: 'Calculated vacant matches stated count',
      status: 'passed',
      details: `${calculated} vacant units matches stated count`,
    };
  }

  return {
    id: 'vacant-count',
    name: 'Vacant Count',
    description: 'Calculated vacant matches stated count',
    status: 'failed',
    details: `Calculated ${calculated} vs stated ${stated}`,
  };
}

function checkTotalSqft(
  statedStats: StatedSummaryStats | null,
  calculatedStats: SummaryStats | null
): VerificationCheck {
  if (!statedStats?.totalSqft || !calculatedStats?.totalSqft) {
    return {
      id: 'total-sqft',
      name: 'Total Sqft',
      description: 'Calculated total sqft matches stated total',
      status: 'skipped',
      details: 'No stated total sqft in document',
    };
  }

  const stated = statedStats.totalSqft;
  const calculated = calculatedStats.totalSqft;
  const diff = Math.abs(stated - calculated);
  const tolerance = stated * 0.01; // 1% tolerance

  if (diff <= tolerance || diff <= 10) {
    return {
      id: 'total-sqft',
      name: 'Total Sqft',
      description: 'Calculated total sqft matches stated total',
      status: 'passed',
      details: `${calculated.toLocaleString()} sqft matches stated ${stated.toLocaleString()}`,
    };
  }

  return {
    id: 'total-sqft',
    name: 'Total Sqft',
    description: 'Calculated total sqft matches stated total',
    status: 'failed',
    details: `Calculated ${calculated.toLocaleString()} vs stated ${stated.toLocaleString()} (diff: ${diff})`,
  };
}
