import type { MVPUnit, SummaryStats } from '../types';
import { aggregateCharges } from './chargeNormalization';

/**
 * Rent booked against non-tenant units (model/down/vacant/applicant) —
 * usually accounting entries (e.g. market rent charged to the model
 * apartment). Excluded from totalMonthlyRent, but documents' stated totals
 * often include it, so stated-vs-calculated reconciliation needs the number.
 * Exported so the UI can compute it live from units even when a cached
 * record's summaryStats predates the nonTenantRent field.
 */
export function nonTenantRentFromUnits(units: MVPUnit[]): number | null {
  const sum = units
    .filter(u => u.status !== 'occupied' && u.status !== 'notice' && u.monthlyRent !== null && u.monthlyRent > 0)
    .reduce((total, u) => total + (u.monthlyRent || 0), 0);
  return sum > 0 ? sum : null;
}

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

  const nonTenantRent = nonTenantRentFromUnits(units);

  // Rent-component totals. Null (not 0) when no unit carries the component, so
  // documents without these columns don't display misleading zeros.
  const sumOrNull = (vals: (number | null | undefined)[]): number | null => {
    const present = vals.filter((v): v is number => v !== null && v !== undefined);
    return present.length > 0 ? Math.round(present.reduce((a, b) => a + b, 0) * 100) / 100 : null;
  };
  // Market rent applies to every unit (including vacant) — that's what makes it
  // comparable to a document's gross-potential total.
  const totalMarketRent = sumOrNull(units.map(u => u.marketRent));
  const totalSubsidyRent = sumOrNull(rentPayingUnits.map(u => u.subsidyRent));
  const totalTenantPaidRent = totalMonthlyRent !== null
    ? Math.round((totalMonthlyRent - (totalSubsidyRent ?? 0)) * 100) / 100
    : null;
  const totalEmployeeDiscount = sumOrNull(units.map(u => u.employeeDiscount));
  const totalConcessions = sumOrNull(units.map(u => u.concession));

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

  // Check if any units have itemized charges
  const unitsWithCharges = units.filter(u => u.charges && u.charges.length > 0);
  const hasItemizedCharges = unitsWithCharges.length > 0;

  // Aggregate charges if present
  let chargeSummary;
  let totalChargesAmount;
  if (hasItemizedCharges) {
    const chargeAggregation = aggregateCharges(units);
    chargeSummary = chargeAggregation.summary;
    totalChargesAmount = chargeAggregation.totalAmount;
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
    nonTenantRent,
    totalMarketRent,
    totalSubsidyRent,
    totalTenantPaidRent,
    totalEmployeeDiscount,
    totalConcessions,
    averageRent,
    averageSqft,
    averageRentPerSqft,
    hasItemizedCharges,
    chargeSummary,
    totalChargesAmount,
  };
}
