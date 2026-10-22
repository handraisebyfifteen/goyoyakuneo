import type { Response } from "express";
import { errorMessage, type ErrorCode } from "@shared/i18n";
import type { Language } from "@shared/schema";
import { BookingError } from "./lib/booking";

export class ApiError extends Error {
  constructor(public code: ErrorCode, public status = 400, public params: Record<string, string | number> = {}) {
    super(code);
  }
}

export function sendError(res: Response, lang: Language, err: unknown): void {
  if (err instanceof ApiError || err instanceof BookingError) {
    res.status(err.status).json({ ok: false, code: err.code, message: errorMessage(err.code, lang, err.params) });
    return;
  }
  // 想定外のエラー：本人には短く、詳しい内容はログにだけ残す
  console.error("[server_error]", err);
  res.status(500).json({ ok: false, code: "server_error", message: errorMessage("server_error", lang) });
}
