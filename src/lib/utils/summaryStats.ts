import type { MVPUnit, SummaryStats } from '../types';

/**
 * Calculate summary statistics from extracted units
 */
export function calculateSummaryStats(units: MVPUnit[]): SummaryStats {
  const totalUnits = units.length;

  // Count by status
  const occupiedUnits = units.filter(u => u.status === 'occupied').length;
  const vacantUnits = units.filter(u => u.status === 'vacant').length;
  const noticeUnits = units.filter(u => u.status === 'notice').length;
  const modelUnits = units.filter(u => u.status === 'model').length;
  const downUnits = units.filter(u => u.status === 'down').length;
  const applicantUnits = units.filter(u => u.status === 'applicant').length;

  // Physical occupancy: (occupied + notice) / total * 100
  // Notice units are still physically occupied
  const physicallyOccupied = occupiedUnits + noticeUnits;
  const physicalOccupancy = totalUnits > 0
    ? Math.round((physicallyOccupied / totalUnits) * 10000) / 100  // Round to 2 decimal places
    : null;

  // Sum of sqft (only count units that have sqft data)
  const unitsWithSqft = units.filter(u => u.unitSqft !== null && u.unitSqft > 0);
  const totalSqft = unitsWithSqft.length > 0
    ? unitsWithSqft.reduce((sum, u) => sum + (u.unitSqft || 0), 0)
    : null;

  // Sum of monthly rent (only occupied and notice units)
  const rentPayingUnits = units.filter(
    u => (u.status === 'occupied' || u.status === 'notice') && u.monthlyRent !== null && u.monthlyRent > 0
  );
  const totalMonthlyRent = rentPayingUnits.length > 0
    ? rentPayingUnits.reduce((sum, u) => sum + (u.monthlyRent || 0), 0)
    : null;

  // Average rent (only for rent-paying units)
  const averageRent = rentPayingUnits.length > 0 && totalMonthlyRent !== null
    ? Math.round(totalMonthlyRent / rentPayingUnits.length)
    : null;

  // Average sqft
  const averageSqft = unitsWithSqft.length > 0 && totalSqft !== null
    ? Math.round(totalSqft / unitsWithSqft.length)
    : null;

  // Average rent per sqft (only for units with both rent and sqft)
  const unitsWithBoth = units.filter(
    u => (u.status === 'occupied' || u.status === 'notice') &&
         u.monthlyRent !== null && u.monthlyRent > 0 &&
         u.unitSqft !== null && u.unitSqft > 0
  );
  let averageRentPerSqft: number | null = null;
  if (unitsWithBoth.length > 0) {
    const totalRentForCalc = unitsWithBoth.reduce((sum, u) => sum + (u.monthlyRent || 0), 0);
    const totalSqftForCalc = unitsWithBoth.reduce((sum, u) => sum + (u.unitSqft || 0), 0);
    if (totalSqftForCalc > 0) {
      averageRentPerSqft = Math.round((totalRentForCalc / totalSqftForCalc) * 100) / 100;
    }
  }

  return {
    totalUnits,
    occupiedUnits,
    vacantUnits,
    noticeUnits,
    modelUnits,
    downUnits,
    applicantUnits,
    physicalOccupancy,
    totalSqft,
    totalMonthlyRent,
    averageRent,
    averageSqft,
    averageRentPerSqft,
  };
}
