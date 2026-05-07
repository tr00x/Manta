import type { z } from 'zod';
import { BusValidationError } from '../errors';

/**
 * Validate `input` against `schema`, throwing a typed `BusValidationError` on
 * failure. The error carries `issues` so the MCP server can surface them in
 * the structured `validation_error` envelope.
 *
 * Returning `z.infer<S>` keeps the call-site type-safe — handlers don't need
 * a separate cast after parse.
 *
 * Implementation note: `safeParse(...).data` types as `any` on a generic
 * `ZodTypeAny` (zod can't compute the inferred type from the generic
 * upper-bound). We funnel the result through `unknown` and re-cast at the
 * function boundary instead of returning `any` directly — this keeps the
 * `@typescript-eslint/no-unsafe-return` rule satisfied without a per-line
 * disable directive. At call sites `z.infer<S>` resolves to the concrete
 * schema output type, so the cast is sound.
 */
export function parse<TOut, TIn>(
  schema: z.ZodType<TOut, z.ZodTypeDef, TIn>,
  input: unknown,
  label: string,
): TOut {
  const r = schema.safeParse(input);
  if (!r.success) {
    throw new BusValidationError(`invalid input for ${label}`, r.error.issues);
  }
  return r.data;
}
