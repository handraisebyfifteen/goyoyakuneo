import { test } from "node:test";
import assert from "node:assert/strict";
import { candidatesFor, busyFor, orderCandidates, type StaffLite } from "./staffing";

const s = (id: number, o: Partial<StaffLite> = {}): StaffLite => ({ id, name: `S${id}`, treats: true, acceptNominated: true, acceptFree: true, menuIds: null, active: true, sortOrder: id, ...o });
const team = [s(1), s(2, { acceptNominated: false }), s(3, { menuIds: [10] }), s(4, { treats: false }), s(5, { active: false }), s(6, { acceptFree: false })];

test("フリーの予約は「フリーを受ける」施術者だけ。コースの制限も守る", () => {
  assert.deepEqual(candidatesFor(team, { menuId: 20, source: "web" }).map((x) => x.id), [1, 2]);
  assert.deepEqual(candidatesFor(team, { menuId: 10, source: "web" }).map((x) => x.id), [1, 2, 3]);
});

test("指名は「指名を受ける」人だけ。フリーのみの人は指名できない", () => {
  assert.deepEqual(candidatesFor(team, { menuId: 10, staffId: 1, source: "web" }).map((x) => x.id), [1]);
  assert.deepEqual(candidatesFor(team, { menuId: 10, staffId: 2, source: "web" }), []);
  assert.deepEqual(candidatesFor(team, { menuId: 20, staffId: 3, source: "web" }), []); // Aコースのみの人に別のコース
});

test("オーナーが入れる予約は、指名・フリーの設定より優先する（コースの制限と施術するかは守る）", () => {
  assert.deepEqual(candidatesFor(team, { menuId: 10, staffId: 2, source: "owner" }).map((x) => x.id), [2]);
  assert.deepEqual(candidatesFor(team, { menuId: null, source: "owner" }).map((x) => x.id), [1, 2, 3, 6]);
  assert.deepEqual(candidatesFor(team, { menuId: null, staffId: 4, source: "owner" }), []);
});

test("重なりはスタッフごと。お店全体のお休みと担当なしの予約は全員をふさぐ", () => {
  const t = new Date();
  const busy = {
    reservations: [{ id: 1, startAt: t, endAt: t, label: "a", staffId: 1 }, { id: 2, startAt: t, endAt: t, label: "b", staffId: 2 }, { id: 3, startAt: t, endAt: t, label: "c", staffId: null }],
    blocked: [{ id: 9, startAt: t, endAt: t, label: "", staffId: null }, { id: 8, startAt: t, endAt: t, label: "", staffId: 2 }],
  };
  const b1 = busyFor(1, busy);
  assert.deepEqual(b1.reservations.map((r) => r.id), [1, 3]);
  assert.deepEqual(b1.blocked.map((r) => r.id), [9]);
});

test("試す順番は、今の担当 → その日の予約が少ない人", () => {
  const t = new Date();
  const day = [{ id: 1, startAt: t, endAt: t, label: "", staffId: 1 }, { id: 2, startAt: t, endAt: t, label: "", staffId: 1 }, { id: 3, startAt: t, endAt: t, label: "", staffId: 2 }];
  assert.deepEqual(orderCandidates([s(1), s(2), s(3)], day).map((x) => x.id), [3, 2, 1]);
  assert.deepEqual(orderCandidates([s(1), s(2), s(3)], day, 1).map((x) => x.id), [1, 3, 2]);
});
