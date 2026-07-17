import type { GenericRentRollUnit } from '../types';

export interface CellHighlight {
  type: 'outlier' | 'warning' | 'critical';
  message: string;
}

export interface UnitHighlights {
  monthlyRent?: CellHighlight;
  unitSqft?: CellHighlight;
  tenantName?: CellHighlight;
  status?: CellHighlight;
}

/**
 * Calculate quartiles and IQR for outlier detection
 */
function calculateQuartiles(values: number[]): { q1: number; q3: number; iqr: number; median: number } {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;

  if (n === 0) return { q1: 0, q3: 0, iqr: 0, median: 0 };

  const median = n % 2 === 0
    ? (sorted[n / 2 - 1] + sorted[n / 2]) / 2
    : sorted[Math.floor(n / 2)];

  const q1Index = Math.floor(n * 0.25);
  const q3Index = Math.floor(n * 0.75);

  const q1 = sorted[q1Index];
  const q3 = sorted[q3Index];
  const iqr = q3 - q1;

  return { q1, q3, iqr, median };
}

/**
 * Calculate statistics for a numeric field
 */
function calculateStats(values: number[]): { mean: number; stdDev: number; min: number; max: number } {
  if (values.length === 0) return { mean: 0, stdDev: 0, min: 0, max: 0 };

  const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
  const squaredDiffs = values.map(v => Math.pow(v - mean, 2));
  const avgSquaredDiff = squaredDiffs.reduce((sum, v) => sum + v, 0) / values.length;
  const stdDev = Math.sqrt(avgSquaredDiff);

  return {
    mean,
    stdDev,
    min: Math.min(...values),
    max: Math.max(...values),
  };
}

/**
 * Detect outliers and data quality issues for all units
 */
export function detectHighlights(units: GenericRentRollUnit[]): Map<number, UnitHighlights> {
  const highlights = new Map<number, UnitHighlights>();

  // Get valid rent values for occupied/notice units
  const occupiedRents = units
    .filter(u => (u.status === 'occupied' || u.status === 'notice') && u.monthlyRent !== null && u.monthlyRent > 0)
    .map(u => u.monthlyRent as number);

  // Get valid sqft values
  const sqftValues = units
    .filter(u => u.unitSqft !== null && u.unitSqft > 0)
    .map(u => u.unitSqft as number);

  // Calculate rent statistics
  const rentStats = calculateQuartiles(occupiedRents);
  const rentLowerBound = rentStats.q1 - 1.5 * rentStats.iqr;
  const rentUpperBound = rentStats.q3 + 1.5 * rentStats.iqr;
  const rentMean = occupiedRents.length > 0
    ? occupiedRents.reduce((sum, v) => sum + v, 0) / occupiedRents.length
    : 0;

  // Calculate sqft statistics
  const sqftStats = calculateQuartiles(sqftValues);
  const sqftLowerBound = sqftStats.q1 - 1.5 * sqftStats.iqr;
  const sqftUpperBound = sqftStats.q3 + 1.5 * sqftStats.iqr;

  units.forEach((unit, index) => {
    const unitHighlights: UnitHighlights = {};

    // Check rent outliers (only for occupied/notice units with rent)
    if ((unit.status === 'occupied' || unit.status === 'notice') && unit.monthlyRent !== null) {
      if (occupiedRents.length >= 5) { // Need enough data points for meaningful outlier detection
        if (unit.monthlyRent < rentLowerBound && rentStats.iqr > 0) {
          const percentBelow = ((rentMean - unit.monthlyRent) / rentMean * 100).toFixed(0);
          unitHighlights.monthlyRent = {
            type: 'outlier',
            message: `Rent is ${percentBelow}% below average ($${rentMean.toLocaleString()})`,
          };
        } else if (unit.monthlyRent > rentUpperBound && rentStats.iqr > 0) {
          const percentAbove = ((unit.monthlyRent - rentMean) / rentMean * 100).toFixed(0);
          unitHighlights.monthlyRent = {
            type: 'outlier',
            message: `Rent is ${percentAbove}% above average ($${rentMean.toLocaleString()})`,
          };
        }
      }
    }

    // Check sqft outliers
    if (unit.unitSqft !== null && sqftValues.length >= 5) {
      const sqftMean = sqftValues.reduce((sum, v) => sum + v, 0) / sqftValues.length;
      if (unit.unitSqft < sqftLowerBound && sqftStats.iqr > 0) {
        const percentBelow = ((sqftMean - unit.unitSqft) / sqftMean * 100).toFixed(0);
        unitHighlights.unitSqft = {
          type: 'outlier',
          message: `Sqft is ${percentBelow}% below average (${sqftMean.toLocaleString()} sqft)`,
        };
      } else if (unit.unitSqft > sqftUpperBound && sqftStats.iqr > 0) {
        const percentAbove = ((unit.unitSqft - sqftMean) / sqftMean * 100).toFixed(0);
        unitHighlights.unitSqft = {
          type: 'outlier',
          message: `Sqft is ${percentAbove}% above average (${sqftMean.toLocaleString()} sqft)`,
        };
      }
    }

    // Data quality checks

    // Occupied unit with no rent
    if ((unit.status === 'occupied' || unit.status === 'notice') && (unit.monthlyRent === null || unit.monthlyRent === 0)) {
      unitHighlights.monthlyRent = {
        type: 'critical',
        message: 'Occupied unit should have rent amount',
      };
    }

    // Vacant unit with tenant name (ignore placeholder names like "VACANT")
    if ((unit.status === 'vacant' || unit.status === 'model' || unit.status === 'down') && unit.tenantName && unit.tenantName.trim() !== '') {
      const normalizedName = unit.tenantName.trim().toLowerCase();
      const isPlaceholderName = normalizedName === 'vacant' || normalizedName === 'vacancy' || normalizedName === 'n/a' || normalizedName === 'none' || normalizedName === '-';
      if (!isPlaceholderName) {
        unitHighlights.tenantName = {
          type: 'warning',
          message: 'Vacant unit has tenant name - verify status is correct',
        };
      }
    }

    // Occupied unit without tenant name (warning, not critical)
    if (unit.status === 'occupied' && (!unit.tenantName || unit.tenantName.trim() === '')) {
      unitHighlights.tenantName = {
        type: 'warning',
        message: 'Occupied unit is missing tenant name',
      };
    }

    // Very low rent (possible data entry error)
    if (unit.monthlyRent !== null && unit.monthlyRent > 0 && unit.monthlyRent < 100) {
      unitHighlights.monthlyRent = {
        type: 'warning',
        message: 'Unusually low rent - verify this is correct',
      };
    }

    // Very high rent (possible data entry error - e.g., annual instead of monthly)
    if (unit.monthlyRent !== null && unit.monthlyRent > 10000) {
      unitHighlights.monthlyRent = {
        type: 'warning',
        message: 'Unusually high rent - verify this is monthly (not annual)',
      };
    }

    // Very small sqft
    if (unit.unitSqft !== null && unit.unitSqft > 0 && unit.unitSqft < 200) {
      unitHighlights.unitSqft = {
        type: 'warning',
        message: 'Unusually small unit size - verify this is correct',
      };
    }

    // Very large sqft
    if (unit.unitSqft !== null && unit.unitSqft > 5000) {
      unitHighlights.unitSqft = {
        type: 'warning',
        message: 'Unusually large unit size - verify this is correct',
      };
    }

    if (Object.keys(unitHighlights).length > 0) {
      highlights.set(index, unitHighlights);
    }
  });

  return highlights;
}

/**
 * Get highlight counts for summary display
 */
export function getHighlightSummary(highlights: Map<number, UnitHighlights>): {
  outliers: number;
  warnings: number;
  critical: number;
  total: number;
} {
  let outliers = 0;
  let warnings = 0;
  let critical = 0;

  highlights.forEach((unitHighlights) => {
    Object.values(unitHighlights).forEach((highlight) => {
      if (highlight) {
        switch (highlight.type) {
          case 'outlier': outliers++; break;
          case 'warning': warnings++; break;
          case 'critical': critical++; break;
        }
      }
    });
  });

  return { outliers, warnings, critical, total: outliers + warnings + critical };
}
