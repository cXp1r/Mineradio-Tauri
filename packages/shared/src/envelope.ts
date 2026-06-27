import { z } from "zod";

export const ApiErrorSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
  provider: z.string().optional(),
  retryable: z.boolean(),
  action: z.string().optional()
});

export const ApiFailureSchema = z.object({
  ok: z.literal(false),
  error: ApiErrorSchema
});

export function ApiSuccessSchema<T extends z.ZodTypeAny>(data: T) {
  return z.object({
    ok: z.literal(true),
    data
  });
}

export type ApiError = z.infer<typeof ApiErrorSchema>;
export type ApiFailure = z.infer<typeof ApiFailureSchema>;
export type ApiSuccess<T> = { ok: true; data: T };
export type ApiResponse<T> = ApiSuccess<T> | ApiFailure;