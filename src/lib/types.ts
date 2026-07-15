// MVP Types - Focused on unit count accuracy

export type UnitStatus = 'occupied' | 'vacant' | 'notice' | 'model' | 'down' | 'applicant';

// Charge code categories for normalization
export type ChargeCategory =
  | 'base_rent'
  | 'pet'
  | 'parking'
  | 'storage'
  | 'utility'
  | 'trash'
  | 'pest_control'
  | 'internet'
  | 'admin_fee'
  | 'deposit_waiver'
  | 'credit_builder'
  | 'concession'
  | 'mtm_fee'
  | 'damages'
  | 'other';

// Individual charge on a unit
export interface UnitCharge {
  code: string;           // Raw code as seen in document (e.g., "Pet Rent - Dog - Bella")
  amount: number;         // Charge amount (negative for concessions)
  category: ChargeCategory;  // Normalized category
}

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

  // Itemized charges (if document has charge breakdowns)
  charges?: UnitCharge[];
  totalCharges?: number;             // Sum of all charges for this unit

  // Metadata for validation
  sourceRow?: number;
  sourcePage?: number;
}

// A notable moment in the extraction pipeline, shown live in the progress
// timeline and persisted to the record as the extraction log.
export interface ProgressEvent {
  at: string; // ISO timestamp
  kind:
    | 'info'        // pipeline step (reading, triage, merging)
    | 'fastpath'    // deterministic no-AI extraction outcome
    | 'attempt'     // an AI extraction attempt started (model + tier)
    | 'verify_pass' // self-verification of an attempt passed
    | 'verify_fail' // self-verification found issues
    | 'escalation'  // moving up the model ladder, with why
    | 'decision';   // which attempt was kept / second-opinion outcome
  message: string;
}

// Live progress for an extraction being processed in the background
export interface ExtractionProgress {
  stage: string;            // e.g. "extracting", "verifying", "validating"
  detail: string | null;    // e.g. 'sheet "Report1" — attempt 2 (claude-opus-4-8), 41KB streamed'
  updatedAt: string;        // ISO timestamp of last heartbeat
  events?: ProgressEvent[]; // append-only timeline of notable moments
}

export interface ValidationIssue {
  type: 'duplicate' | 'gap' | 'count_mismatch' | 'missing_unit_number' | 'suspicious' | 'summary_mismatch';
  severity: 'critical' | 'warning' | 'info';
  message: string;
  unitNumbers?: string[];
  details?: Record<string, unknown>;
}

// Property-level charge summary
export interface ChargeCategorySummary {
  category: ChargeCategory;
  totalAmount: number;
  unitCount: number;
  rawCodes: string[];  // Unique raw codes that mapped to this category
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
  // Rent charged against non-tenant units (model/down/vacant/applicant) —
  // often bookkeeping entries a document's stated total includes but
  // totalMonthlyRent (occupied+notice only) deliberately excludes.
  // Optional: records processed before this field exist without it.
  nonTenantRent?: number | null;
  averageRent: number | null;
  averageSqft: number | null;
  averageRentPerSqft: number | null;

  // Charge summary (if document has itemized charges)
  hasItemizedCharges: boolean;
  chargeSummary?: ChargeCategorySummary[];
  totalChargesAmount?: number;  // Sum of all non-rent charges
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

// Verification check result (like a unit test)
export interface VerificationCheck {
  id: string;
  name: string;
  description: string;
  status: 'passed' | 'failed' | 'skipped';  // skipped = no stated value to compare
  details?: string;  // Additional context for the result
}

// Overall verification summary
export interface VerificationSummary {
  confidence: 'high' | 'medium' | 'low';
  confidenceReason: string;
  passed: number;
  failed: number;
  skipped: number;
  total: number;
  checks: VerificationCheck[];
}

// Explanation for a mismatch (generated by AI analysis)
export interface MismatchExplanation {
  checkId: string;
  checkName: string;
  explanation: string;
  rootCause: 'category_mismatch' | 'extraction_error' | 'data_quality' | 'unknown';
  affectedUnits?: string[];
  recommendation?: string;
}

// Summary of all explanations
export interface ExplanationSummary {
  hasExplanations: boolean;
  explanations: MismatchExplanation[];
  overallAssessment: string;
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

  // Verification checks (like unit tests)
  verificationSummary: VerificationSummary | null;

  // AI-generated explanations for mismatches
  explanationSummary: ExplanationSummary | null;

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

  // Live progress while status === 'processing' (server-side jobs only)
  progress?: ExtractionProgress | null;

  // Persisted timeline of how the extraction ran (models tried, escalations,
  // verification outcomes) — kept after completion for the review page.
  extractionLog?: ProgressEvent[] | null;
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
  // Verification summary
  verificationPassed: number | null;
  verificationFailed: number | null;
  verificationSkipped: number | null;
  verificationConfidence: 'high' | 'medium' | 'low' | null;
}
