// Core rent-roll types - focused on unit count accuracy

export type UnitStatus = 'occupied' | 'vacant' | 'notice' | 'model' | 'down' | 'applicant';

// Charge code categories for normalization
/**
 * Charge-line category. Three economic classes, which is what consumers
 * actually need to separate:
 *   RENT       — the contract rent itself (base_rent, subsidy)
 *   ADJUSTMENT — reductions/losses against rent, never ancillary income
 *                (concession, loss_to_lease, vacancy_loss)
 *   INCOME     — everything billed on top of rent (all remaining categories)
 * `RENT_CLASS_CATEGORIES` in utils/chargeNormalization.ts is the authority on
 * which categories are excluded from the ancillary-income summary.
 */
export type ChargeCategory =
  // rent
  | 'base_rent'
  | 'subsidy'          // HUD/HAP/Section 8/voucher portion of contract rent
  // ancillary income
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
  | 'mtm_fee'
  | 'damages'
  | 'tax_recovery'     // real estate/property tax billed back to the resident
  | 'other_income'     // identified ancillary income with no specific bucket
  // rent adjustments (not income)
  | 'concession'
  | 'loss_to_lease'    // gain/loss to lease against market
  | 'vacancy_loss'
  // unclassified
  | 'other';

// Individual charge on a unit
export interface UnitCharge {
  code: string;           // Raw code as seen in document (e.g., "Pet Rent - Dog - Bella")
  amount: number;         // Charge amount (negative for concessions)
  category: ChargeCategory;  // Normalized category
}

// Verbatim passthrough of a document column not mapped to a first-class field.
// Copied exactly as printed and NOT interpreted — consumers apply their own
// (e.g. jurisdiction-specific) meaning. This is how the parser preserves
// columns like rent-regulation / lease-type, legal or registered rent, DHCR
// codes, etc. without baking any domain logic into the generic engine.
export interface SourceColumn {
  header: string;         // Column header text, verbatim
  value: string;          // Cell value, verbatim
}

export interface GenericRentRollUnit {
  unitNumber: string;
  building?: string | null;  // Building/property for multi-building documents; null when single-property
  status: UnitStatus;
  monthlyRent: number | null;
  tenantName: string | null;

  // Rent components (optional: records processed before these fields exist
  // without them). monthlyRent is the TOTAL contract rent (tenant + subsidy);
  // subsidyRent is the portion paid by a housing-assistance program, so
  // tenant-paid = monthlyRent - subsidyRent.
  marketRent?: number | null;        // Market/asking rent for the unit
  subsidyRent?: number | null;       // Subsidy/HAP portion of monthlyRent
  employeeDiscount?: number | null;  // Recurring employee/other discount (negative as shown)
  concession?: number | null;        // Recurring concession amount (negative as shown)

  // Generic classification of what the row IS (populated by the v2 extractor).
  // This is factual, NOT a legal/regulatory status: a rent-stabilized apartment
  // is still category "residential". Consumers derive regulation themselves.
  category?: 'residential' | 'commercial' | 'non_unit_income' | null;
  includeInUnitCount?: boolean | null;  // false for non_unit_income (parking/antenna/laundry/storage/signage)

  // Verbatim passthrough of document columns not mapped to a field below
  // (e.g. a rent-regulation / lease-type column, legal/registered rent, DHCR
  // codes). Preserved so downstream consumers can interpret them; never
  // interpreted by the engine itself.
  sourceColumns?: SourceColumn[];

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
    | 'preview'     // quick read of the document's stated summary (before unit extraction)
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
  // Rent-component totals (optional: records processed before these fields
  // exist without them; null when no unit carries the component).
  totalMarketRent?: number | null;       // All units with a market rent
  totalSubsidyRent?: number | null;      // Subsidy portion across rent-paying units
  totalTenantPaidRent?: number | null;   // totalMonthlyRent minus subsidy
  totalEmployeeDiscount?: number | null; // Sum of recurring employee/other discounts
  totalConcessions?: number | null;      // Sum of recurring concessions
  averageRent: number | null;
  averageSqft: number | null;
  averageRentPerSqft: number | null;

  // Charge summary (if document has itemized charges). Rent-class lines
  // (base_rent/subsidy) are excluded from both — the rent totals above already
  // carry them. Rent adjustments (concession/loss_to_lease/vacancy_loss) and
  // unidentified codes (`other`) are LISTED in chargeSummary but excluded from
  // totalChargesAmount, so the summary rows deliberately do not all sum to that
  // total. Check for an `other` row before treating the total as complete: a
  // large one means codes went unrecognized, not that income is missing.
  hasItemizedCharges: boolean;
  chargeSummary?: ChargeCategorySummary[];
  totalChargesAmount?: number;  // Identified ancillary income only (see above)
}

// Stated summary values extracted from the document (not calculated)
export interface StatedSummaryStats {
  totalUnits: number | null;
  totalMonthlyRent: number | null;
  // Market/potential rent total when the document states one separately from
  // the actual-rent total (optional: older records don't have it).
  totalMarketRent?: number | null;
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
  units: GenericRentRollUnit[];

  // Count validation (critical for count accuracy)
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
  // Cache-aware estimated API cost in USD across all calls in the run
  // (extraction + preview + triage + explainer). Optional: records processed
  // before this field exist without it.
  costUSD?: number | null;

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
  costUSD?: number | null;
  // Verification summary
  verificationPassed: number | null;
  verificationFailed: number | null;
  verificationSkipped: number | null;
  verificationConfidence: 'high' | 'medium' | 'low' | null;
}
