/**
 * ログイン。パスワードでも合言葉でも入れる（オーナーの設定による）。
 * セッションは PostgreSQL に保存。ハッシュは scrypt。
 */
import type { Express, Request, Response, NextFunction } from "express";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import { z } from "zod";
import { pool } from "./db";
import * as storage from "./storage";
import { hashSecret, verifySecret, hashPassphrase, verifyPassphrase, passphraseLongEnough } from "./lib/passphrase";
import { ApiError, sendError } from "./errors";
import { LOGIN_METHODS, LANGUAGES, DEFAULT_HOURS, type Owner } from "@shared/schema";
import { normalizeLang } from "@shared/i18n";
import { randomBytes } from "node:crypto";
import { isValidTimeZone } from "./lib/time";

// 端末の時間帯から国と通貨を決める（登録のときに聞かないため）。知らない時間帯なら言語で決める
const REGION_BY_TZ: Record<string, { country: string; currency: string }> = {
  "Asia/Tokyo": { country: "JP", currency: "JPY" }, "Asia/Seoul": { country: "KR", currency: "KRW" }, "Asia/Singapore": { country: "SG", currency: "SGD" },
  "Europe/London": { country: "GB", currency: "GBP" }, "Europe/Paris": { country: "FR", currency: "EUR" }, "Europe/Berlin": { country: "DE", currency: "EUR" },
  "Australia/Sydney": { country: "AU", currency: "AUD" }, "Australia/Melbourne": { country: "AU", currency: "AUD" }, "America/Toronto": { country: "CA", currency: "CAD" },
  "America/Vancouver": { country: "CA", currency: "CAD" }, "America/New_York": { country: "US", currency: "USD" }, "America/Chicago": { country: "US", currency: "USD" },
  "America/Denver": { country: "US", currency: "USD" }, "America/Los_Angeles": { country: "US", currency: "USD" },
};
function regionFor(timezone: string | undefined, isJa: boolean) {
  const known = timezone ? REGION_BY_TZ[timezone] : undefined;
  if (known && timezone) return { ...known, timezone };
  return isJa ? { country: "JP", currency: "JPY", timezone: "Asia/Tokyo" } : { country: "US", currency: "USD", timezone: "America/New_York" };
}

declare module "express-session" {
  /** オーナーとスタッフは別々にログインする（同じブラウザではどちらか一方） */
  interface SessionData { ownerId?: number; staffId?: number }
}

export function setupSession(app: Express) {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error("SESSION_SECRET is not set");
  const PgStore = connectPgSimple(session);
  app.set("trust proxy", 1);
  app.use(session({
    store: new PgStore({ pool, createTableIfMissing: true, tableName: "sessions" }),
    secret,
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", maxAge: 1000 * 60 * 60 * 24 * 30 },
  }));
}

export type AuthedRequest = Request & { owner: Owner };

export function requireOwner(req: Request, res: Response, next: NextFunction) {
  const id = req.session.ownerId;
  if (!id) return sendError(res, normalizeLang(req.query.lang), new ApiError("unauthorized", 401));
  storage.getOwner(id).then((owner) => {
    if (!owner) {
      req.session.ownerId = undefined;
      return sendError(res, normalizeLang(req.query.lang), new ApiError("unauthorized", 401));
    }
    (req as AuthedRequest).owner = owner;
    next();
  }).catch(next);
}

const signupSchema = z.object({
  email: z.string().email().max(200),
  password: z.string().min(8).max(200).optional(),
  passphrase: z.string().min(1).max(200).optional(),
  loginMethod: z.enum(LOGIN_METHODS).default("both"),
  shopName: z.string().min(1).max(100),
  language: z.enum(LANGUAGES).default("ja"),
  timezone: z.string().max(60).optional(),
});

const loginSchema = z.object({
  email: z.string().email(),
  secret: z.string().min(1).max(200),
});

function makeSlug(): string {
  return "shop-" + randomBytes(3).toString("hex");
}

export function registerAuthRoutes(app: Express) {
  app.post("/api/auth/signup", async (req, res) => {
    const lang = normalizeLang(req.body?.language ?? req.query.lang);
    try {
      const parsed = signupSchema.safeParse(req.body);
      if (!parsed.success) throw new ApiError("validation", 400);
      const body = parsed.data;
      if ((body.loginMethod === "password" || body.loginMethod === "both") && !body.password) throw new ApiError("validation", 400);
      if ((body.loginMethod === "passphrase" || body.loginMethod === "both") && !body.passphrase) throw new ApiError("validation", 400);
      if (body.passphrase && !passphraseLongEnough(body.passphrase)) throw new ApiError("passphrase_short", 400);
      if (await storage.getOwnerByEmail(body.email)) throw new ApiError("email_in_use", 409);

      const isJa = body.language === "ja";
      const owner = await storage.createOwner({
        email: body.email.toLowerCase().trim(),
        passwordHash: body.password ? hashSecret(body.password) : null,
        passphraseHash: body.passphrase ? hashPassphrase(body.passphrase) : null,
        loginMethod: body.loginMethod,
        shopNameJa: isJa ? body.shopName : "",
        shopNameEn: isJa ? "" : body.shopName,
        language: body.language,
        ...regionFor(body.timezone && isValidTimeZone(body.timezone) ? body.timezone : undefined, isJa),
        hours: DEFAULT_HOURS,
        slug: makeSlug(),
      });
      req.session.ownerId = owner.id;
      res.status(201).json({ ok: true, owner: storage.publicOwner(owner) });
    } catch (e) {
      sendError(res, lang, e);
    }
  });

  app.post("/api/auth/login", async (req, res) => {
    const lang = normalizeLang(req.body?.language ?? req.query.lang);
    try {
      const parsed = loginSchema.safeParse(req.body);
      if (!parsed.success) throw new ApiError("validation", 400);
      const owner = await storage.getOwnerByEmail(parsed.data.email);
      const secret = parsed.data.secret;
      let ok = false;
      if (owner) {
        const m = owner.loginMethod;
        if ((m === "password" || m === "both") && verifySecret(secret, owner.passwordHash)) ok = true;
        if (!ok && (m === "passphrase" || m === "both") && verifyPassphrase(secret, owner.passphraseHash)) ok = true;
      }
      if (!owner || !ok) {
        // オーナーでなければ、スタッフのパスワードで入れるかを見る
        const member = await storage.getStaffByEmail(parsed.data.email);
        if (member && member.active && verifySecret(secret, member.passwordHash)) {
          req.session.ownerId = undefined;
          req.session.staffId = member.id;
          return res.json({ ok: true, owner: null, staff: storage.publicStaff(member) });
        }
        throw new ApiError("login_failed", 401);
      }
      req.session.staffId = undefined;
      req.session.ownerId = owner.id;
      res.json({ ok: true, owner: storage.publicOwner(owner) });
    } catch (e) {
      sendError(res, lang, e);
    }
  });

  app.post("/api/auth/logout", (req, res) => {
    req.session.destroy(() => res.json({ ok: true }));
  });

  app.get("/api/auth/me", async (req, res) => {
    const id = req.session.ownerId;
    const owner = id ? await storage.getOwner(id) : undefined;
    res.json({ ok: true, owner: owner ? storage.publicOwner(owner) : null });
  });

  /** 合言葉を決める・変える（AI を通さない。本人のセッションから直接） */
  app.post("/api/owner/passphrase", requireOwner, async (req, res) => {
    const owner = (req as AuthedRequest).owner;
    const lang = normalizeLang(owner.language);
    try {
      const body = z.object({ passphrase: z.string().min(1).max(200), current: z.string().max(200).optional() }).parse(req.body);
      if (owner.passphraseHash && !verifyPassphrase(body.current ?? "", owner.passphraseHash)) throw new ApiError("passphrase_wrong", 403);
      if (!passphraseLongEnough(body.passphrase)) throw new ApiError("passphrase_short", 400);
      const updated = await storage.updateOwner(owner.id, { passphraseHash: hashPassphrase(body.passphrase) });
      res.json({ ok: true, owner: storage.publicOwner(updated) });
    } catch (e) {
      sendError(res, lang, e instanceof z.ZodError ? new ApiError("validation") : e);
    }
  });
}
