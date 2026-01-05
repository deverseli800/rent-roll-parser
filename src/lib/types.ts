// MVP Types - Focused on unit count accuracy

export type UnitStatus = 'occupied' | 'vacant' | 'notice' | 'model' | 'down' | 'applicant';

export interface MVPUnit {
  unitNumber: string;
  status: UnitStatus;
  monthlyRent: number | null;
  tenantName: string | null;

  // Additional fields (all optional)
  unitSqft: number | null;
  unitType: string | null;           // e.g., "1BR/1BA", "Studio", "2BR/2BA"
  leaseStatus: string | null;        // Raw lease status from source (e.g., "Occupied", "Vacant-Leased")
  moveInDate: string | null;         // ISO date string
  moveOutDate: string | null;        // ISO date string
  leaseStartDate: string | null;     // ISO date string
  leaseEndDate: string | null;       // ISO date string

  // Metadata for validation
  sourceRow?: number;
  sourcePage?: number;
}

export interface ValidationIssue {
  type: 'duplicate' | 'gap' | 'count_mismatch' | 'missing_unit_number' | 'suspicious' | 'summary_mismatch';
  severity: 'critical' | 'warning' | 'info';
  message: string;
  unitNumbers?: string[];
  details?: Record<string, unknown>;
}

export interface SummaryStats {
  totalUnits: number;
  occupiedUnits: number;
  vacantUnits: number;
  noticeUnits: number;
  modelUnits: number;
  downUnits: number;
  applicantUnits: number;

  // Calculated metrics
  physicalOccupancy: number | null;  // Percentage (0-100)
  totalSqft: number | null;
  totalMonthlyRent: number | null;
  averageRent: number | null;
  averageSqft: number | null;
  averageRentPerSqft: number | null;
}

// Stated summary values extracted from the document (not calculated)
export interface StatedSummaryStats {
  totalUnits: number | null;
  totalMonthlyRent: number | null;
  totalSqft: number | null;
  occupancyRate: number | null;      // Percentage if stated in document
  occupiedUnits: number | null;
  vacantUnits: number | null;
}

export interface RentRollExtraction {
  id: string;
  fileName: string;
  propertyName: string | null;
  uploadedAt: string;
  processedAt: string | null;
  status: 'processing' | 'review' | 'approved' | 'error';

  // Unit data
  units: MVPUnit[];

  // Count validation (critical for MVP)
  statedUnitCount: number | null;  // From document if found
  extractedUnitCount: number;
  countMatch: boolean | null;  // null if stated count not found

  // Summary statistics (calculated from units)
  summaryStats: SummaryStats | null;

  // Stated summary values from document (for validation)
  statedSummaryStats: StatedSummaryStats | null;

  // Validation results
  validationIssues: ValidationIssue[];

  // Extraction metadata
  sourceType: 'excel' | 'pdf';
  sourceFormat: string | null;  // 'onesite' | 'resman' | 'simple' | 'unknown'
  processingTimeMs: number | null;
  pageCount: number | null;

  // AI usage tracking
  modelUsed: string | null;           // e.g., 'claude-sonnet-4-20250514'
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;

  // Error info if failed
  error: string | null;
}

export interface ExtractionSummary {
  id: string;
  fileName: string;
  propertyName: string | null;
  status: RentRollExtraction['status'];
  extractedUnitCount: number;
  statedUnitCount: number | null;
  countMatch: boolean | null;
  criticalIssues: number;
  uploadedAt: string;
  processingTimeMs: number | null;
  error: string | null;
  // AI usage tracking
  modelUsed: string | null;
  totalTokens: number | null;
}
