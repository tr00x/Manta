import type { z } from 'zod';
import { BusValidationError } from '../errors';

/**
 * Validate `input` against `schema`, throwing a typed `BusValidationError` on
 * failure. The error carries `issues` so the MCP server can surface them in
 * the structured `validation_error` envelope.
 *
 * Returning `z.infer<S>` keeps the call-site type-safe — handlers don't need
 * a separate cast after parse. We launder through `unknown` because zod
 * types `safeParse(...)`'s `data` as `any` on a generic `ZodTypeAny`, which
 * trips the type-aware lint rules; the cast is sound because we just
 * confirmed `r.success === true`.
 */
export function parse<S extends z.ZodTypeAny>(schema: S, input: unknown, label: string): z.infer<S> {
  const r = schema.safeParse(input);
  if (!r.success) {
    throw new BusValidationError(`invalid input for ${label}`, r.error.issues);
  }
  // Within this function `z.infer<S>` resolves to `any` (the upper bound is
  // ZodTypeAny). At call sites it resolves to the concrete schema's output
  // type, so the cast is sound; eslint can't see through the generic and
  // needs the directive.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-return
  return r.data;
}
