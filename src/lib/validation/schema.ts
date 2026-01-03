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
  sourceRow: z.number().optional(),
  sourcePage: z.number().optional(),
});

export const ValidationIssueSchema = z.object({
  type: z.enum(['duplicate', 'gap', 'count_mismatch', 'missing_unit_number', 'suspicious']),
  severity: z.enum(['critical', 'warning', 'info']),
  message: z.string(),
  unitNumbers: z.array(z.string()).optional(),
  details: z.record(z.string(), z.unknown()).optional(),
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

  validationIssues: z.array(ValidationIssueSchema),

  sourceType: z.enum(['excel', 'pdf']),
  sourceFormat: z.string().nullable(),
  processingTimeMs: z.number().nullable(),
  pageCount: z.number().nullable(),

  error: z.string().nullable(),
});

// Schema for Claude Vision API response
export const ClaudeExtractionResponseSchema = z.object({
  propertyName: z.string().nullable().optional(),
  statedTotalUnits: z.number().nullable().optional(),
  units: z.array(z.object({
    unitNumber: z.string(),
    status: z.string(),
    monthlyRent: z.number().nullable().optional(),
    tenantName: z.string().nullable().optional(),
  })),
  extractedCount: z.number().optional(),
  countMatch: z.boolean().optional(),
});

export type MVPUnitInput = z.infer<typeof MVPUnitSchema>;
export type RentRollExtractionInput = z.infer<typeof RentRollExtractionSchema>;
export type ClaudeExtractionResponse = z.infer<typeof ClaudeExtractionResponseSchema>;
