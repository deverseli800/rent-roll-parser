import type {
  GenericRentRollUnit,
  StatedSummaryStats,
  SummaryStats,
  VerificationCheck,
  VerificationSummary,
} from '../types';
import { reconcileOccupiedCount, reconcileTotalRent, reconcileUnitCount, reconcileVacantCount } from '../utils/occupancy';

/**
 * Run all verification checks and return a summary
 * Similar to unit tests - each check passes, fails, or is skipped
 */
export function runVerificationChecks(
  units: GenericRentRollUnit[],
  statedUnitCount: number | null,
  statedStats: StatedSummaryStats | null,
  calculatedStats: SummaryStats | null
): VerificationSummary {
  const checks: VerificationCheck[] = [];

  // Check 1: Unit count matches stated count
  checks.push(checkUnitCount(units, statedUnitCount));

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

  // Check 8: Total market rent matches — only included when either side has
  // market data, so documents without a market rent column aren't penalized
  // with a permanently-skipped check.
  const marketCheck = checkTotalMarketRent(statedStats, calculatedStats);
  if (marketCheck) checks.push(marketCheck);

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
  units: GenericRentRollUnit[],
  statedCount: number | null
): VerificationCheck {
  const extractedCount = units.length;
  if (statedCount === null) {
    return {
      id: 'unit-count',
      name: 'Unit Count',
      description: 'Extracted count matches stated count in document',
      status: 'skipped',
      details: 'No stated unit count found in document',
    };
  }

  const rec = reconcileUnitCount(statedCount, units);
  if (rec.ok) {
    const how =
      rec.interpretation === 'all'
        ? 'matches stated count'
        : rec.interpretation === 'residential_only'
          ? `stated count matches the ${statedCount} residential units (remainder is commercial/other)`
          : `stated count matches the ${statedCount} unit rows (remainder is ancillary income lines)`;
    return {
      id: 'unit-count',
      name: 'Unit Count',
      description: 'Extracted count matches stated count in document',
      status: 'passed',
      details: `${extractedCount} units extracted, ${how}`,
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

function checkNoDuplicates(units: GenericRentRollUnit[]): VerificationCheck {
  const seen = new Set<string>();
  const duplicates: string[] = [];

  // Key on building + unit: multi-building documents legitimately repeat unit
  // numbers across buildings ("1A" in both 122 and 124).
  for (const unit of units) {
    const normalized = `${(unit.building ?? '').trim().toUpperCase()}|${unit.unitNumber.trim().toUpperCase()}`;
    if (seen.has(normalized)) {
      duplicates.push(unit.building ? `${unit.building} ${unit.unitNumber}` : unit.unitNumber);
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

function checkNoMissingUnitNumbers(units: GenericRentRollUnit[]): VerificationCheck {
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

  // Reconcile rather than compare raw: stated totals often include rent
  // booked to model/down units that tenant-rent deliberately excludes.
  const reconciliation = reconcileTotalRent(
    statedStats.totalMonthlyRent,
    calculatedStats.totalMonthlyRent,
    calculatedStats.nonTenantRent
  );

  return {
    id: 'total-rent',
    name: 'Total Rent',
    description: 'Calculated tenant rent reconciles with stated total',
    status: reconciliation.ok ? 'passed' : 'failed',
    details: reconciliation.explanation,
  };
}

function checkTotalMarketRent(
  statedStats: StatedSummaryStats | null,
  calculatedStats: SummaryStats | null
): VerificationCheck | null {
  const stated = statedStats?.totalMarketRent ?? null;
  const calculated = calculatedStats?.totalMarketRent ?? null;
  if (stated === null && calculated === null) return null; // document has no market rent data

  if (stated === null || calculated === null) {
    return {
      id: 'total-market-rent',
      name: 'Total Market Rent',
      description: 'Calculated market rent total matches stated total',
      status: 'skipped',
      details: stated === null
        ? 'No stated market rent total in document'
        : 'No per-unit market rents extracted to compare against the stated total',
    };
  }

  const diff = Math.abs(stated - calculated);
  const tolerance = Math.max(5, stated * 0.005);
  if (diff <= tolerance) {
    return {
      id: 'total-market-rent',
      name: 'Total Market Rent',
      description: 'Calculated market rent total matches stated total',
      status: 'passed',
      details: `$${Math.round(calculated).toLocaleString()} matches stated $${Math.round(stated).toLocaleString()}`,
    };
  }

  return {
    id: 'total-market-rent',
    name: 'Total Market Rent',
    description: 'Calculated market rent total matches stated total',
    status: 'failed',
    details: `Calculated $${Math.round(calculated).toLocaleString()} vs stated $${Math.round(stated).toLocaleString()} (diff: $${Math.round(diff).toLocaleString()})`,
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
  // Documents count notice units (tenant still in place) as occupied, and may
  // roll model/down units in too — reconcile rather than compare occupied-only.
  const reconciliation = reconcileOccupiedCount(stated, {
    occupied: calculatedStats?.occupiedUnits ?? 0,
    vacant: calculatedStats?.vacantUnits ?? 0,
    notice: calculatedStats?.noticeUnits ?? 0,
    model: calculatedStats?.modelUnits ?? 0,
    down: calculatedStats?.downUnits ?? 0,
    applicant: calculatedStats?.applicantUnits ?? 0,
  });

  return {
    id: 'occupied-count',
    name: 'Occupied Count',
    description: 'Calculated occupied (incl. notice) matches stated count',
    status: reconciliation.ok ? 'passed' : 'failed',
    details: reconciliation.explanation,
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
  // Documents count applicant units (physically empty, lease not started) as
  // vacant, and may roll model/down units in too — reconcile rather than
  // compare vacant-only, mirroring the occupied-count check.
  const reconciliation = reconcileVacantCount(stated, {
    occupied: calculatedStats?.occupiedUnits ?? 0,
    vacant: calculatedStats?.vacantUnits ?? 0,
    notice: calculatedStats?.noticeUnits ?? 0,
    model: calculatedStats?.modelUnits ?? 0,
    down: calculatedStats?.downUnits ?? 0,
    applicant: calculatedStats?.applicantUnits ?? 0,
  });

  return {
    id: 'vacant-count',
    name: 'Vacant Count',
    description: 'Calculated vacant reconciles with stated count',
    status: reconciliation.ok ? 'passed' : 'failed',
    details: reconciliation.explanation,
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
