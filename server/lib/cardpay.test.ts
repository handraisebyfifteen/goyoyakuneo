import { test } from "node:test";
import assert from "node:assert/strict";
import { stateOf } from "../cardpay";

const req = (currently_due: string[] = [], past_due: string[] = []) => ({ currently_due, past_due }) as never;

test("入金先の状態：登録の途中 → 確認中 → 使える。追加の情報を求められていたら止まっている", () => {
  assert.equal(stateOf({ charges_enabled: false, details_submitted: false, requirements: req(["external_account"]) }), "incomplete");
  assert.equal(stateOf({ charges_enabled: false, details_submitted: true, requirements: req() }), "reviewing");
  assert.equal(stateOf({ charges_enabled: false, details_submitted: true, requirements: req([], ["individual.verification.document"]) }), "restricted");
  assert.equal(stateOf({ charges_enabled: true, details_submitted: true, requirements: req(["individual.id_number"]) }), "ready");
});
