import * as XLSX from 'xlsx';
import type { RentRollExtraction, GenericRentRollUnit } from '../types';

/**
 * Column headers matching the vendor format (RRTable)
 */
const HEADERS = [
  'Unit #',
  'Unit Type',
  'Square Foot',
  'Status',
  'Tenant Name',
  'Tenant Paid',
  'Employee Discount',
  'Subsidy',
  'Total Rent',
  'RR Market Rent (Ask)',
  'Rent Roll Concessions',
  'Move In Date',
  'Lease Start Date',
  'Lease End Date',
  'Lease Term',
];

/**
 * Convert our status to the vendor format
 */
function formatStatus(status: string): string {
  switch (status) {
    case 'occupied':
      return 'O';
    case 'vacant':
      return 'Vacant';
    case 'notice':
      return 'Notice';
    case 'model':
      return 'Model';
    case 'down':
      return 'Down';
    case 'applicant':
      return 'Applicant';
    default:
      return status;
  }
}

/**
 * Parse date string to Excel serial date number
 */
function dateToExcelSerial(dateStr: string | null): number | null {
  if (!dateStr) return null;

  const date = new Date(dateStr);
  if (isNaN(date.getTime())) return null;

  // Excel serial date: days since 1899-12-30
  const excelEpoch = new Date(1899, 11, 30);
  const diffMs = date.getTime() - excelEpoch.getTime();
  const diffDays = Math.floor(diffMs / (24 * 60 * 60 * 1000));

  return diffDays;
}

/**
 * Convert a unit to a row in the vendor format
 */
function unitToRow(unit: GenericRentRollUnit): (string | number | null)[] {
  return [
    unit.unitNumber,                          // Unit #
    unit.unitType,                            // Unit Type
    unit.unitSqft,                            // Square Foot
    formatStatus(unit.status),                // Status
    unit.tenantName,                          // Tenant Name
    unit.monthlyRent,                         // Tenant Paid
    null,                                     // Employee Discount
    null,                                     // Subsidy
    null,                                     // Total Rent
    null,                                     // RR Market Rent (Ask)
    null,                                     // Rent Roll Concessions
    dateToExcelSerial(unit.moveInDate),       // Move In Date
    dateToExcelSerial(unit.leaseStartDate),   // Lease Start Date
    dateToExcelSerial(unit.leaseEndDate),     // Lease End Date
    null,                                     // Lease Term
  ];
}

/**
 * Export extraction to Excel in the vendor format
 */
export function exportToExcel(extraction: RentRollExtraction): Buffer {
  // Create workbook
  const workbook = XLSX.utils.book_new();

  // Create data array with headers
  const data: (string | number | null)[][] = [
    HEADERS,
    ...extraction.units.map(unitToRow),
  ];

  // Create worksheet
  const worksheet = XLSX.utils.aoa_to_sheet(data);

  // Set column widths
  worksheet['!cols'] = [
    { wch: 10 },  // Unit #
    { wch: 12 },  // Unit Type
    { wch: 12 },  // Square Foot
    { wch: 10 },  // Status
    { wch: 25 },  // Tenant Name
    { wch: 12 },  // Tenant Paid
    { wch: 18 },  // Employee Discount
    { wch: 10 },  // Subsidy
    { wch: 12 },  // Total Rent
    { wch: 18 },  // RR Market Rent (Ask)
    { wch: 20 },  // Rent Roll Concessions
    { wch: 12 },  // Move In Date
    { wch: 14 },  // Lease Start Date
    { wch: 14 },  // Lease End Date
    { wch: 12 },  // Lease Term
  ];

  // Format date columns
  const dateColumns = [11, 12, 13]; // Move In, Lease Start, Lease End (0-indexed)
  const range = XLSX.utils.decode_range(worksheet['!ref'] || 'A1');

  for (let r = 1; r <= range.e.r; r++) {
    for (const c of dateColumns) {
      const cellRef = XLSX.utils.encode_cell({ r, c });
      const cell = worksheet[cellRef];
      if (cell && typeof cell.v === 'number') {
        cell.t = 'n';
        cell.z = 'mm/dd/yyyy';
      }
    }
  }

  // Add worksheet to workbook
  XLSX.utils.book_append_sheet(workbook, worksheet, 'RRTable');

  // Write to buffer
  const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });

  return buffer;
}
