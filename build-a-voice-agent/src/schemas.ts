import { z } from "zod";

export const lookupCustomerSchema = z.object({
  contact: z.string().trim().min(1),
});

export const createSupportTicketSchema = z.object({
  customerId: z.string().trim().min(1),
  issue: z.string().trim().min(5),
  deviceModel: z.string().trim().min(1).optional(),
  firmwareVersion: z.string().trim().min(1).optional(),
  symptom: z.string().trim().min(1).optional(),
  errorCode: z.string().trim().min(1).optional(),
});

export const createSupportTicketRequestSchema = createSupportTicketSchema.extend({
  requestId: z.string().trim().regex(/^[A-Za-z0-9_-]{8,200}$/, "Invalid requestId"),
});

export const humanResolutionSchema = z.object({
  answer: z.string().trim().min(1).max(10_000),
});
