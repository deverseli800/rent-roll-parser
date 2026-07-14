import type { ChargeCategory, UnitCharge, ChargeCategorySummary } from '../types';

/**
 * Normalize a raw charge code to a standard category.
 * Uses pattern matching to handle the vast variety of charge codes
 * across different property management systems.
 */
export function normalizeChargeCode(rawCode: string): ChargeCategory {
  const c = rawCode.toLowerCase().trim();

  // Base rent - must be exact or very close
  if (c === 'rent' || c === 'base rent' || c === 'market rent' || c === 'lease rent') {
    return 'base_rent';
  }

  // Pet charges
  if (c.includes('pet') || c.includes('animal')) {
    return 'pet';
  }

  // Parking
  if (c.includes('parking') || c.includes('garage') || c.includes('carport') || c.startsWith('park')) {
    return 'parking';
  }

  // Storage - various formats like "Stor27: 223", "Storage #333"
  if (c.includes('storage') || c.startsWith('stor') || /^st\d+/.test(c)) {
    return 'storage';
  }

  // Internet/WiFi
  if (c.includes('wifi') || c.includes('wi-fi') || c.includes('internet') || c.includes('cable')) {
    return 'internet';
  }

  // Trash
  if (c.includes('trash') || c.includes('garbage') || c.includes('waste') || c.includes('refuse')) {
    return 'trash';
  }

  // Pest control
  if (c.includes('pest') || c.includes('exterminator')) {
    return 'pest_control';
  }

  // Utilities (water, electric, gas, sewer)
  if (
    c.includes('water') ||
    c.includes('sewer') ||
    c.includes('electric') ||
    c.includes('gas') ||
    c.includes('utility') ||
    c.includes('utilities') ||
    c.includes('convergent')  // Common utility billing service
  ) {
    return 'utility';
  }

  // Admin/service fees
  if (
    c.includes('admin') ||
    c.includes('service fee') ||
    c.includes('resident service') ||
    c.includes('amenity') ||
    c.includes('move-in') ||
    c.includes('move in') ||
    c.includes('application')
  ) {
    return 'admin_fee';
  }

  // Deposit waiver
  if (c.includes('deposit waiver') || c.includes('surety') || c.includes('rhino')) {
    return 'deposit_waiver';
  }

  // Credit builder programs
  if (c.includes('credit builder') || c.includes('credit report') || c.includes('creditbuilder')) {
    return 'credit_builder';
  }

  // Month-to-month fees
  if (c.includes('mtm') || c.includes('month-to-month') || c.includes('month to month')) {
    return 'mtm_fee';
  }

  // Concessions (typically negative amounts, but detect by name too)
  if (
    c.includes('concession') ||
    c.includes('discount') ||
    c.includes('credit') ||
    c.includes('free') ||
    c.includes('waive') ||
    c.includes('courtesy')
  ) {
    // Make sure we don't match "credit builder" here
    if (!c.includes('credit builder')) {
      return 'concession';
    }
  }

  // Damages
  if (c.includes('damage') || c.includes('repair') || c.includes('charge back')) {
    return 'damages';
  }

  return 'other';
}

/**
 * Create a UnitCharge object from raw code and amount
 */
export function createCharge(code: string, amount: number): UnitCharge {
  return {
    code,
    amount,
    category: normalizeChargeCode(code),
  };
}

/**
 * Aggregate charges across all units into a property-level summary
 */
export function aggregateCharges(
  units: Array<{ charges?: UnitCharge[] }>
): {
  summary: ChargeCategorySummary[];
  totalAmount: number;
} {
  const categoryMap = new Map<
    ChargeCategory,
    { totalAmount: number; unitCount: number; rawCodes: Set<string> }
  >();

  let totalAmount = 0;

  for (const unit of units) {
    if (!unit.charges) continue;

    // Track which categories this unit has (for unitCount)
    const unitCategories = new Set<ChargeCategory>();

    for (const charge of unit.charges) {
      // Skip base rent from charge summary (it's tracked separately)
      if (charge.category === 'base_rent') continue;

      totalAmount += charge.amount;
      unitCategories.add(charge.category);

      let entry = categoryMap.get(charge.category);
      if (!entry) {
        entry = { totalAmount: 0, unitCount: 0, rawCodes: new Set() };
        categoryMap.set(charge.category, entry);
      }

      entry.totalAmount += charge.amount;
      entry.rawCodes.add(charge.code);
    }

    // Increment unit count for each category this unit has
    for (const cat of unitCategories) {
      const entry = categoryMap.get(cat);
      if (entry) entry.unitCount++;
    }
  }

  // Convert to array and sort by total amount descending
  const summary: ChargeCategorySummary[] = Array.from(categoryMap.entries())
    .map(([category, data]) => ({
      category,
      totalAmount: Math.round(data.totalAmount * 100) / 100,
      unitCount: data.unitCount,
      rawCodes: Array.from(data.rawCodes).sort(),
    }))
    .sort((a, b) => Math.abs(b.totalAmount) - Math.abs(a.totalAmount));

  return {
    summary,
    totalAmount: Math.round(totalAmount * 100) / 100,
  };
}
