/**
 * Shared HTTP helpers for tool routes. Stable error envelope so the
 * shell's router can surface `error` codes to Claude without parsing
 * free-form `message` strings.
 */

import { NextResponse } from "next/server";
import type { ZodError } from "zod";

export function errorResponse(
  error: string,
  status: number,
  message?: string,
  details?: Record<string, unknown>,
) {
  return NextResponse.json(
    {
      error,
      ...(message ? { message } : {}),
      ...(details ? { details } : {}),
    },
    { status },
  );
}

export function badRequestFromZod(err: ZodError) {
  return errorResponse(
    "bad_request",
    400,
    "Request body failed validation.",
    {
      issues: err.issues.map((i) => ({
        path: i.path.join("."),
        message: i.message,
        code: i.code,
      })),
    },
  );
}
