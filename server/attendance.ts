/**
 * 勤怠：予定（入り・上がり）→ 打刻 → オーナーの確認、のダブルチェック。
 * - スタッフは打刻の前に予定を決めておく。予定の前後（clockToleranceMinutes、初期値30分）に打刻すれば「予定どおり」
 * - 予定から外れた・予定がない・その日に予定を変えた打刻は「要確認」の印を付ける
 * - 打刻も予定の登録・変更も、1件ずつお知らせに残す。管理画面を開いたときに AI の要約で伝える（ai/briefing.ts）
 * - 打刻はすべてオーナーが確認する。時刻を直したら、元の時刻を残して確認済みにする
 * - 「予定どおりか」「要確認か」はオーナーだけに見せる。スタッフには自分の予定と打刻だけ（プレッシャーをかけない）
 * - お知らせの受け取り方（全部／確認が必要なものだけ／伝えない、メールでも）は会話で決まる（owners.noticePrefs）
 */
import type { Express, Request, Response } from "express";
import { z } from "zod";
import type { Owner, Staff, Language, TimeEntry, AttendanceEvent, AttendanceFlag, Shift } from "@shared/schema";
import { DEFAULT_NOTICE } from "@shared/schema";
import { sendOwnerNotice } from "./email";
import { normalizeLang } from "@shared/i18n";
import * as storage from "./storage";
import { requireOwner, type AuthedRequest } from "./auth";
import { ApiError, sendError } from "./errors";
import { todayFor } from "./services";
import { clockFlag, describeFlag, windowText } from "./lib/attendance";
import { fromLocal, toLocal, addDays, isValidDate, isValidTime, isValidCloseTime } from "./lib/time";

const hm = (t: string) => { const [h, m] = t.split(":").map(Number); return { h, m }; };
/** 読み上げ向けの時刻（「10時5分」「10:05」） */
export function spokenClock(time: string, lang: Language): string {
  if (lang !== "ja") return time;
  const { h, m } = hm(time);
  return `${h}時${m ? `${m}分` : ""}`;
}

// ---------- 予定 ----------

/** 予定を決める・変える。過去の日は変えられない。その日になってからの変更は印が付く */
export async function setShiftFor(owner: Owner, member: Staff, date: string, planStart: string, planEnd: string): Promise<Shift> {
  if (!isValidDate(date)) throw new ApiError("invalid_date");
  if (!isValidTime(planStart) || !isValidCloseTime(planEnd) || planStart >= planEnd) throw new ApiError("invalid_time");
  const today = todayFor(owner);
  if (date < today) throw new ApiError("past_time");
  if (date > addDays(today, owner.planHorizonDays)) throw new ApiError("plan_too_far", 400, { days: owner.planHorizonDays });
  const cur = await storage.getShift(member.id, date);
  const now = new Date();
  if (!cur) {
    const s = await storage.createShift({ ownerId: owner.id, staffId: member.id, date, planStart, planEnd });
    await storage.addAttendanceEvent({ ownerId: owner.id, staffId: member.id, kind: "plan_set", at: now, data: { date, planStart, planEnd } });
    return s;
  }
  if (cur.planStart === planStart && cur.planEnd === planEnd) return cur;
  const s = await storage.updateShift(cur.id, { planStart, planEnd, updatedAt: now, changedOnDay: cur.changedOnDay || date === today });
  await storage.addAttendanceEvent({ ownerId: owner.id, staffId: member.id, kind: "plan_changed", at: now,
    data: { date, from: { planStart: cur.planStart, planEnd: cur.planEnd }, to: { planStart, planEnd }, onDay: date === today } });
  return s;
}

// ---------- 打刻 ----------

/** 今の打刻の見通し：次に押すのは出勤か退勤か、予定と、予定どおりの幅のうちか */
export async function clockOutlook(owner: Owner, member: Staff, now = new Date()) {
  const open = await storage.openTimeEntry(member.id);
  const today = todayFor(owner);
  const tol = owner.clockToleranceMinutes;
  const shift = open?.shiftId ? await storage.getShiftById(open.shiftId) : await storage.getShift(member.id, today);
  const next: "in" | "out" = open ? "out" : "in";
  const planned = shift ? (next === "in" ? shift.planStart : shift.planEnd) : null;
  const within = shift && planned ? clockFlag(next, now, fromLocal(shift.date, planned, owner.timezone), tol) === null : false;
  return { next, open, shift, planned, within, window: planned ? windowText(planned, tol) : null, tolerance: tol };
}

export async function clockFor(owner: Owner, member: Staff, action: "in" | "out", now = new Date()): Promise<TimeEntry | null> {
  const tz = owner.timezone;
  const tol = owner.clockToleranceMinutes;
  const open = await storage.openTimeEntry(member.id);
  // 二度押しは何もしない（出勤中に出勤、退勤後に退勤）
  if (action === "in" && open) return open;
  if (action === "out" && !open) return null;

  if (action === "in") {
    const date = toLocal(now, tz).date;
    const shift = await storage.getShift(member.id, date);
    const flags: AttendanceFlag[] = [];
    if (!shift) flags.push({ code: "no_plan" });
    else {
      const f = clockFlag("in", now, fromLocal(date, shift.planStart, tz), tol);
      if (f) flags.push(f);
      if (shift.changedOnDay) flags.push({ code: "plan_changed" });
    }
    const entry = await storage.createTimeEntry({ ownerId: owner.id, staffId: member.id, clockIn: now, shiftId: shift?.id ?? null, planStart: shift?.planStart ?? null, planEnd: shift?.planEnd ?? null, flags });
    const ev = await storage.addAttendanceEvent({ ownerId: owner.id, staffId: member.id, entryId: entry.id, kind: "clock_in", at: now, data: { time: toLocal(now, tz).time, planned: shift?.planStart ?? null, flags } });
    await emailIfNeeded(owner, member, ev);
    return entry;
  }

  const entry = open!;
  const flags = [...entry.flags];
  const shift = entry.shiftId ? await storage.getShiftById(entry.shiftId) : undefined;
  if (shift) {
    const f = clockFlag("out", now, fromLocal(shift.date, shift.planEnd, tz), tol);
    if (f) flags.push(f);
    // 出勤してから上がりの予定を変えていたら、それも確認に回す
    if (shift.updatedAt.getTime() > entry.clockIn.getTime() && !flags.some((x) => x.code === "plan_changed")) flags.push({ code: "plan_changed" });
  }
  const updated = (await storage.updateTimeEntry(owner.id, entry.id, { clockOut: now, flags, planEnd: shift?.planEnd ?? entry.planEnd })) ?? entry;
  const ev = await storage.addAttendanceEvent({ ownerId: owner.id, staffId: member.id, entryId: entry.id, kind: "clock_out", at: now,
    data: { time: toLocal(now, tz).time, planned: shift?.planEnd ?? null, flags: flags.slice(entry.flags.length) } });
  await emailIfNeeded(owner, member, ev);
  return updated;
}

/** 確認が必要な打刻を、オーナーが望んでいればその場でメールでも知らせる（失敗しても打刻は残す） */
async function emailIfNeeded(owner: Owner, member: Staff, ev: AttendanceEvent) {
  const prefs = owner.noticePrefs ?? DEFAULT_NOTICE;
  if (!prefs.attendanceEmail || prefs.attendance === "off" || !((ev.data as { flags?: unknown[] }).flags ?? []).length) return;
  const lang: Language = owner.language === "en" ? "en" : "ja";
  try { await sendOwnerNotice(owner, lang === "ja" ? "打刻の確認のお願い" : "Clock record to check", describeEvent(ev, member.name, lang) + (lang === "ja" ? "。" : ".")); }
  catch (e) { console.error("[email]", e); }
}

// ---------- オーナーの確認・修正 ----------

/** 確認する。ids を渡せばその打刻、staffId ならその人の分。onlyOk なら「予定どおり」のものだけ。退勤前のものは確認しない */
export async function confirmEntriesFor(owner: Owner, opt: { ids?: number[]; staffId?: number; onlyOk?: boolean }): Promise<{ confirmed: number; leftToCheck: number }> {
  const all = await storage.listUnconfirmedEntries(owner.id);
  const target = all.filter((e) => e.clockOut && (!opt.ids || opt.ids.includes(e.id)) && (!opt.staffId || e.staffId === opt.staffId) && (!opt.onlyOk || !e.flags.length));
  const now = new Date();
  for (const e of target) await storage.updateTimeEntry(owner.id, e.id, { confirmedAt: now });
  const left = all.filter((e) => !target.includes(e) && e.flags.length).length;
  return { confirmed: target.length, leftToCheck: left };
}

/** 時刻を直す（その打刻の日付の「HH:MM」で）。元の時刻を残し、確認済みにする */
export async function correctEntryFor(owner: Owner, entry: TimeEntry, input: { clockIn?: string; clockOut?: string }): Promise<TimeEntry> {
  const tz = owner.timezone;
  const date = toLocal(entry.clockIn, tz).date;
  const at = (t: string) => {
    if (!isValidCloseTime(t)) throw new ApiError("invalid_time");
    return fromLocal(date, t, tz);
  };
  const clockIn = input.clockIn ? at(input.clockIn) : entry.clockIn;
  let clockOut = input.clockOut ? at(input.clockOut) : entry.clockOut;
  // 退勤が出勤より前の時刻なら、日付をまたいだとみなす
  if (clockOut && clockOut <= clockIn && input.clockOut) clockOut = fromLocal(addDays(date, 1), input.clockOut, tz);
  if (clockOut && clockOut <= clockIn) throw new ApiError("invalid_time");
  const now = new Date();
  const updated = (await storage.updateTimeEntry(owner.id, entry.id, {
    clockIn, clockOut, originalIn: entry.originalIn ?? entry.clockIn, originalOut: entry.originalOut ?? entry.clockOut, correctedAt: now, confirmedAt: now,
  })) ?? entry;
  await storage.addAttendanceEvent({ ownerId: owner.id, staffId: entry.staffId, entryId: entry.id, kind: "corrected", at: now, notifiedAt: now,
    data: { date, from: { in: toLocal(entry.clockIn, tz).time, out: entry.clockOut ? toLocal(entry.clockOut, tz).time : null }, to: { in: toLocal(clockIn, tz).time, out: clockOut ? toLocal(clockOut, tz).time : null } } });
  return updated;
}

// ---------- 見せ方 ----------

export function entryView(owner: Owner, e: TimeEntry, staffName: string, lang: Language) {
  const tz = owner.timezone;
  return {
    id: e.id, staffId: e.staffId, staffName, date: toLocal(e.clockIn, tz).date,
    clockIn: toLocal(e.clockIn, tz).time, clockOut: e.clockOut ? toLocal(e.clockOut, tz).time : null,
    planStart: e.planStart, planEnd: e.planEnd, onPlan: e.flags.length === 0, issues: e.flags.map((f) => describeFlag(f, lang)),
    confirmed: !!e.confirmedAt, corrected: !!e.correctedAt,
    original: e.correctedAt ? { in: toLocal(e.originalIn ?? e.clockIn, tz).time, out: e.originalOut ? toLocal(e.originalOut, tz).time : null } : null,
  };
}

/** お知らせ1件を、読み上げ向けの一文に */
export function describeEvent(ev: AttendanceEvent, staffName: string, lang: Language): string {
  const ja = lang === "ja";
  const d = ev.data as Record<string, any>;
  const who = ja ? `${staffName}さん` : staffName;
  const issues = ((d.flags ?? []) as AttendanceFlag[]).map((f) => describeFlag(f, lang));
  const day = (date: string) => { const [, m, dd] = String(date).split("-").map(Number); return ja ? `${m}月${dd}日` : `${m}/${dd}`; };
  switch (ev.kind) {
    case "clock_in":
    case "clock_out": {
      const what = ev.kind === "clock_in" ? (ja ? "出勤" : "clocked in") : (ja ? "退勤" : "clocked out");
      const base = ja ? `${who}が${spokenClock(d.time, lang)}に${what}` : `${who} ${what} at ${d.time}`;
      if (!issues.length) return base + (d.planned ? (ja ? "（予定どおり）" : " (on plan)") : "");
      return base + (ja ? `。${issues.join("、")}ので、確認が必要です` : `; needs checking: ${issues.join(", ")}`);
    }
    case "plan_set": return ja ? `${who}が${day(d.date)}の予定を${spokenClock(d.planStart, lang)}から${spokenClock(d.planEnd, lang)}に決めました` : `${who} set the plan for ${day(d.date)}: ${d.planStart}–${d.planEnd}`;
    case "plan_changed": return ja
      ? `${who}が${d.onDay ? "当日に" : ""}${day(d.date)}の予定を、「${spokenClock(d.from.planStart, lang)}から${spokenClock(d.from.planEnd, lang)}まで」から「${spokenClock(d.to.planStart, lang)}から${spokenClock(d.to.planEnd, lang)}まで」に変えました`
      : `${who} changed the plan for ${day(d.date)}${d.onDay ? " on the day" : ""}: ${d.from.planStart}–${d.from.planEnd} to ${d.to.planStart}–${d.to.planEnd}`;
    case "corrected": return ja ? `${day(d.date)}の${who}の打刻を直しました` : `Corrected ${who}'s clock record for ${day(d.date)}`;
    default: return ev.kind;
  }
}

/** オーナー向けの一覧：確認待ちの打刻と、最近のお知らせ */
export async function attendanceOverview(owner: Owner, lang: Language) {
  const names = new Map((await storage.listStaff(owner.id)).map((s) => [s.id, s.name]));
  const pending = (await storage.listUnconfirmedEntries(owner.id)).map((e) => entryView(owner, e, names.get(e.staffId) ?? "", lang));
  const events = (await storage.listRecentEvents(owner.id, 20)).map((ev) => ({ id: ev.id, at: ev.at.toISOString(), text: describeEvent(ev, names.get(ev.staffId) ?? "", lang) }));
  return { pending, events, tolerance: owner.clockToleranceMinutes };
}

/**
 * 管理画面を開いたときに伝える勤怠のまとめ。まだ伝えていないお知らせを短くまとめ、伝えたことにする。
 * 予定どおりの打刻は件数だけ、要確認と予定の変更は1件ずつ。最後に確認待ちの件数
 */
export async function attendanceBriefing(owner: Owner, lang: Language, now = new Date()): Promise<string> {
  const ja = lang === "ja";
  const prefs = owner.noticePrefs ?? DEFAULT_NOTICE;
  const events = await storage.listUnnotifiedEvents(owner.id);
  // 「伝えない」なら、伝えたことにだけして何も言わない（管理画面の一覧には残る）
  if (prefs.attendance === "off") { await storage.markEventsNotified(owner.id, events.map((e) => e.id), now); return ""; }
  const names = new Map((await storage.listStaff(owner.id)).map((s) => [s.id, s.name]));
  const parts: string[] = [];
  const clocks = events.filter((e) => e.kind === "clock_in" || e.kind === "clock_out");
  const ok = clocks.filter((e) => !((e.data as { flags?: unknown[] }).flags ?? []).length);
  const ng = clocks.filter((e) => ((e.data as { flags?: unknown[] }).flags ?? []).length);
  // 予定の変更は伝える。当日に初めて決めた予定は「全部」のときだけ
  const plans = events.filter((e) => e.kind === "plan_changed" || (prefs.attendance === "all" && e.kind === "plan_set" && (e.data as { date?: string }).date === todayFor(owner)));
  if (ok.length && prefs.attendance === "all") parts.push(ja ? `前回から、予定どおりの出勤・退勤が${ok.length}回ありました。` : `Since last time, ${ok.length} clock-in${ok.length > 1 ? "s and outs were" : " or out was"} on plan.`);
  for (const e of ng) parts.push(describeEvent(e, names.get(e.staffId) ?? "", lang) + (ja ? "。" : "."));
  for (const e of plans) parts.push(describeEvent(e, names.get(e.staffId) ?? "", lang) + (ja ? "。" : "."));
  await storage.markEventsNotified(owner.id, events.map((e) => e.id), now);
  const pending = (await storage.listUnconfirmedEntries(owner.id)).filter((e) => e.clockOut);
  if (pending.length) {
    const check = pending.filter((e) => e.flags.length).length;
    parts.push(ja
      ? `まだ確認していない勤務の記録（出勤から退勤まで）が${pending.length}件${check ? `、そのうち確認が必要なものが${check}件` : ""}あります。「打刻を確認して」と言えば、予定どおりのものをまとめて確認します。`
      : `${pending.length} work record${pending.length > 1 ? "s" : ""} (clock-in to clock-out) ${pending.length > 1 ? "are" : "is"} waiting for your confirmation${check ? `, ${check} needing a check` : ""}. Say "confirm the clock records" to confirm the ones on plan.`);
  }
  return parts.join(ja ? "" : " ");
}

// ---------- 画面の API ----------

function handle(fn: (req: Request, res: Response, owner: Owner, lang: Language) => Promise<void>) {
  return async (req: Request, res: Response) => {
    const owner = (req as AuthedRequest).owner;
    const lang = normalizeLang(req.query.lang ?? req.body?.lang ?? owner.language);
    try { await fn(req, res, owner, lang); }
    catch (e) { sendError(res, lang, e instanceof z.ZodError ? new ApiError("validation") : e); }
  };
}

export function registerAttendanceRoutes(app: Express) {
  app.get("/api/owner/attendance", requireOwner, handle(async (_req, res, owner, lang) => {
    res.json({ ok: true, ...(await attendanceOverview(owner, lang)) });
  }));
  app.post("/api/owner/attendance/confirm", requireOwner, handle(async (req, res, owner) => {
    const b = z.object({ ids: z.array(z.number().int()).optional(), onlyOk: z.boolean().optional() }).parse(req.body ?? {});
    res.json({ ok: true, ...(await confirmEntriesFor(owner, b)) });
  }));
  app.patch("/api/owner/attendance/:id", requireOwner, handle(async (req, res, owner, lang) => {
    const b = z.object({ clockIn: z.string().optional(), clockOut: z.string().optional() }).parse(req.body);
    const entry = await storage.getTimeEntry(owner.id, Number(req.params.id));
    if (!entry) throw new ApiError("not_found", 404);
    const member = await storage.getStaff(owner.id, entry.staffId);
    res.json({ ok: true, entry: entryView(owner, await correctEntryFor(owner, entry, b), member?.name ?? "", lang) });
  }));
}
