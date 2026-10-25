/**
 * スタッフのいる店で、予約を誰が受けるかを決める計算。AI は使わない純粋な計算。
 * - 受けられる人：在籍している・施術する・そのコースを受けられる（menuIds が null なら全部）
 * - 指名なら、その人が「指名を受ける」こと（オーナーが入れる予約は権限より優先する）
 * - 指名なし（フリー）なら、「フリーを受ける」人の中から、その日の予約が少ない人を先にする
 * - 重なりはスタッフごとに見る。お店全体のお休みと、担当が決まっていない予約は全員をふさぐ
 */
import type { Staff } from "@shared/schema";
import type { Busy } from "./booking";

export type StaffLite = Pick<Staff, "id" | "name" | "treats" | "acceptNominated" | "acceptFree" | "menuIds" | "active" | "sortOrder">;

export function candidatesFor(all: StaffLite[], opt: { menuId: number | null; staffId?: number; source: "web" | "owner" }): StaffLite[] {
  const can = all.filter((s) => s.active && s.treats && (opt.menuId === null || !s.menuIds || s.menuIds.includes(opt.menuId)));
  if (opt.staffId !== undefined) return can.filter((s) => s.id === opt.staffId && (opt.source === "owner" || s.acceptNominated));
  return can.filter((s) => opt.source === "owner" || s.acceptFree);
}

/** そのスタッフにとっての「ふさがっている枠」 */
export function busyFor(staffId: number, busy: { reservations: Busy[]; blocked: Busy[] }): { reservations: Busy[]; blocked: Busy[] } {
  return {
    reservations: busy.reservations.filter((r) => r.staffId == null || r.staffId === staffId),
    blocked: busy.blocked.filter((b) => b.staffId == null || b.staffId === staffId),
  };
}

/** 試す順番：先に試したい人（今の担当など）→ その日の予約が少ない人 → 並び順 */
export function orderCandidates(cands: StaffLite[], dayReservations: Busy[], prefer?: number | null): StaffLite[] {
  const load = (id: number) => dayReservations.filter((r) => r.staffId === id).length;
  return [...cands].sort((a, b) => (b.id === prefer ? 1 : 0) - (a.id === prefer ? 1 : 0) || load(a.id) - load(b.id) || a.sortOrder - b.sortOrder || a.id - b.id);
}
