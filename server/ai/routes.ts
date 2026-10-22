/**
 * 声のパネルの API。合言葉は /passphrase だけで受け取り、ログにも履歴にも残さない。
 */
import type { Express, Request } from "express";
import { z } from "zod";
import { requireOwner, type AuthedRequest } from "../auth";
import { ApiError, sendError } from "../errors";
import { normalizeLang } from "@shared/i18n";
import * as storage from "../storage";
import { agent } from "./agent";
import { aiConfigured, MODELS } from "./llm";
import { readCash, cashChange, spokenCash } from "./vision";
import { money } from "@shared/money";

const ownerOf = (req: Request) => (req as AuthedRequest).owner;

export function registerVoiceRoutes(app: Express) {
  app.get("/api/voice/status", requireOwner, async (req, res) => {
    const owner = ownerOf(req);
    res.json({ ok: true, aiConfigured: aiConfigured(), models: MODELS, pending: agent.hasPending(owner.id), hasPassphrase: !!owner.passphraseHash });
  });

  app.get("/api/voice/history", requireOwner, async (req, res) => {
    const rows = await storage.listChatMessages(ownerOf(req).id, 40);
    res.json({ ok: true, messages: rows.map((r) => ({ id: r.id, role: r.role, content: r.content, model: r.model === MODELS.smart ? "consult" : "daily", createdAt: r.createdAt.toISOString() })) });
  });

  app.post("/api/voice/message", requireOwner, async (req, res) => {
    const owner = ownerOf(req);
    const lang = normalizeLang(owner.language);
    try {
      if (!aiConfigured()) throw new ApiError("ai_unavailable", 503);
      const b = z.object({ text: z.string().min(1).max(2000) }).parse(req.body);
      res.json({ ok: true, ...(await agent.message(owner, b.text.trim())) });
    } catch (e) {
      sendError(res, lang, e instanceof z.ZodError ? new ApiError("validation") : e);
    }
  });

  app.post("/api/voice/confirm", requireOwner, async (req, res) => {
    const owner = ownerOf(req);
    const lang = normalizeLang(owner.language);
    try {
      const b = z.object({ pendingId: z.string().min(1), answer: z.enum(["yes", "no"]) }).parse(req.body);
      res.json({ ok: true, ...(await agent.confirm(owner, b.pendingId, b.answer)) });
    } catch (e) {
      sendError(res, lang, e instanceof z.ZodError ? new ApiError("validation") : e);
    }
  });

  /** 合言葉。AI には渡らない。req.body をログに出さないこと */
  app.post("/api/voice/passphrase", requireOwner, async (req, res) => {
    const owner = ownerOf(req);
    const lang = normalizeLang(owner.language);
    try {
      const b = z.object({ pendingId: z.string().min(1), passphrase: z.string().min(1).max(200) }).parse(req.body);
      const reply = await agent.passphrase(owner, b.pendingId, b.passphrase);
      res.json({ ok: true, ...reply });
    } catch (e) {
      sendError(res, lang, e instanceof z.ZodError ? new ApiError("validation") : e);
    }
  });

  /** お札・硬貨の写真を数えておつりを計算する。記録はしない。写真は保存しない */
  app.post("/api/voice/cash", requireOwner, async (req, res) => {
    const owner = ownerOf(req);
    const lang = normalizeLang(owner.language);
    try {
      if (!aiConfigured()) throw new ApiError("ai_unavailable", 503);
      const b = z.object({ reservationId: z.number().int(), image: z.string().regex(/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/).max(7_000_000) }).parse(req.body);
      const row = await storage.getReservation(owner.id, b.reservationId);
      if (!row) throw new ApiError("reservation_not_found", 404);
      if (row.status === "cancelled") throw new ApiError("already_cancelled");
      if (row.paymentStatus !== "onsite_pending") throw new ApiError("not_onsite_pending");
      let reading;
      try {
        reading = await readCash(b.image, row.currency);
      } catch (e) {
        console.error("[vision_error]", e);
        throw new ApiError("cash_unreadable", 502);
      }
      if (!reading.ok) throw new ApiError(reading.error === "no_cash" ? "cash_not_found" : "cash_unreadable");
      const text = spokenCash(reading, row.price, row.currency, lang);
      const { change, short } = cashChange(row.price, reading.total);
      // 会話の記録に残す（次に「記録して」と言われたとき、AI が金額を知っているように）
      await storage.addChatMessage(owner.id, "user", lang === "ja" ? `（${row.customer.name}さんから受け取ったお金の写真を確認）` : `(Checked a photo of the cash received from ${row.customer.name})`);
      await storage.addChatMessage(owner.id, "assistant", text, MODELS.vision);
      res.json({
        ok: true, text, reservationId: row.id, customerName: row.customer.name, recorded: false,
        items: reading.items.map((i) => ({ value: money(i.value, row.currency, lang), count: i.count })),
        total: money(reading.total, row.currency, lang), due: money(row.price, row.currency, lang),
        change: money(change, row.currency, lang), short: money(short, row.currency, lang),
        confident: reading.confident, note: reading.note,
      });
    } catch (e) {
      sendError(res, lang, e instanceof z.ZodError ? new ApiError("validation") : e);
    }
  });

  app.post("/api/voice/cancel", requireOwner, async (req, res) => {
    agent.cancelPending(ownerOf(req).id);
    res.json({ ok: true });
  });
}
