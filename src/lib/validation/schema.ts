import { z } from "zod";

// MVP Zod Schemas - Focused on unit count accuracy

export const UnitStatusSchema = z.enum([
  'occupied',
  'vacant',
  'notice',
  'model',
  'down',
  'applicant'
]);

export const MVPUnitSchema = z.object({
  unitNumber: z.string().min(1, "Unit number is required"),
  status: UnitStatusSchema,
  monthlyRent: z.number().nullable(),
  tenantName: z.string().nullable(),
  // Additional fields
  unitSqft: z.number().nullable(),
  unitType: z.string().nullable(),
  leaseStatus: z.string().nullable(),
  moveInDate: z.string().nullable(),
  moveOutDate: z.string().nullable(),
  leaseStartDate: z.string().nullable(),
  leaseEndDate: z.string().nullable(),
  // Metadata
  sourceRow: z.number().optional(),
  sourcePage: z.number().optional(),
});

export const ValidationIssueSchema = z.object({
  type: z.enum(['duplicate', 'gap', 'count_mismatch', 'missing_unit_number', 'suspicious', 'summary_mismatch']),
  severity: z.enum(['critical', 'warning', 'info']),
  message: z.string(),
  unitNumbers: z.array(z.string()).optional(),
  details: z.record(z.string(), z.unknown()).optional(),
});

export const SummaryStatsSchema = z.object({
  totalUnits: z.number(),
  occupiedUnits: z.number(),
  vacantUnits: z.number(),
  noticeUnits: z.number(),
  modelUnits: z.number(),
  downUnits: z.number(),
  applicantUnits: z.number(),
  physicalOccupancy: z.number().nullable(),
  totalSqft: z.number().nullable(),
  totalMonthlyRent: z.number().nullable(),
  averageRent: z.number().nullable(),
  averageSqft: z.number().nullable(),
  averageRentPerSqft: z.number().nullable(),
});

// Stated summary values extracted from document (not calculated)
export const StatedSummaryStatsSchema = z.object({
  totalUnits: z.number().nullable(),
  totalMonthlyRent: z.number().nullable(),
  totalSqft: z.number().nullable(),
  occupancyRate: z.number().nullable(),
  occupiedUnits: z.number().nullable(),
  vacantUnits: z.number().nullable(),
});

export const RentRollExtractionSchema = z.object({
  id: z.string().uuid(),
  fileName: z.string(),
  propertyName: z.string().nullable(),
  uploadedAt: z.string().datetime(),
  processedAt: z.string().datetime().nullable(),
  status: z.enum(['processing', 'review', 'approved', 'error']),

  units: z.array(MVPUnitSchema),

  statedUnitCount: z.number().nullable(),
  extractedUnitCount: z.number(),
  countMatch: z.boolean().nullable(),

  summaryStats: SummaryStatsSchema.nullable(),
  statedSummaryStats: StatedSummaryStatsSchema.nullable(),

  validationIssues: z.array(ValidationIssueSchema),

  sourceType: z.enum(['excel', 'pdf']),
  sourceFormat: z.string().nullable(),
  processingTimeMs: z.number().nullable(),
  pageCount: z.number().nullable(),

  // AI usage tracking
  modelUsed: z.string().nullable(),
  inputTokens: z.number().nullable(),
  outputTokens: z.number().nullable(),
  totalTokens: z.number().nullable(),

  error: z.string().nullable(),
});

// Schema for Claude Vision API response
export const ClaudeExtractionResponseSchema = z.object({
  propertyName: z.string().nullable().optional(),
  statedTotalUnits: z.number().nullable().optional(),
  // Stated summary values from document
  statedSummary: z.object({
    totalMonthlyRent: z.number().nullable().optional(),
    totalSqft: z.number().nullable().optional(),
    occupancyRate: z.number().nullable().optional(),
    occupiedUnits: z.number().nullable().optional(),
    vacantUnits: z.number().nullable().optional(),
  }).optional(),
  units: z.array(z.object({
    unitNumber: z.string(),
    status: z.string(),
    monthlyRent: z.number().nullable().optional(),
    tenantName: z.string().nullable().optional(),
    // Additional fields
    unitSqft: z.number().nullable().optional(),
    unitType: z.string().nullable().optional(),
    leaseStatus: z.string().nullable().optional(),
    moveInDate: z.string().nullable().optional(),
    moveOutDate: z.string().nullable().optional(),
    leaseStartDate: z.string().nullable().optional(),
    leaseEndDate: z.string().nullable().optional(),
  })),
  extractedCount: z.number().optional(),
  countMatch: z.boolean().optional(),
});

export type MVPUnitInput = z.infer<typeof MVPUnitSchema>;
export type RentRollExtractionInput = z.infer<typeof RentRollExtractionSchema>;
export type ClaudeExtractionResponse = z.infer<typeof ClaudeExtractionResponseSchema>;
