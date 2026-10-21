"""
計算層だけのテスト（AI もネットも使わない）。
実行: python test_tools.py
"""

import os
import tempfile

os.environ["GOYOYAKU_DATA"] = os.path.join(tempfile.mkdtemp(), "test.json")
os.environ.pop("STRIPE_SECRET_KEY", None)

import tools


def expect_error(fn, *args):
    try:
        fn(*args)
    except ValueError as e:
        print("  正しく止まりました:", e)
        return
    raise AssertionError("止まるはずが通ってしまいました")


tools.create_menu("60分コース", 60, 5000)
tools.create_menu("30分コース", 30, 3000)

a = tools.add_reservation("2026-10-23", "15:00", "60分コース", "田中", "card")["reservation"]
b = tools.add_reservation("2026-10-23", "16:00", "30分コース", "佐藤", "onsite")["reservation"]
print("重なる予約:")
expect_error(tools.add_reservation, "2026-10-23", "15:30", "30分コース", "鈴木", "onsite")

print("予約のある日を休みに:")
expect_error(tools.add_day_off, "2026-10-23")
tools.add_day_off("2026-10-24")
print("休みの日に予約:")
expect_error(tools.add_reservation, "2026-10-24", "10:00", "30分コース", "鈴木", "onsite")

link = tools.create_payment_link(a["id"])
assert link["ok"]
tools.mark_card_paid(a["id"])
tools.record_onsite_payment(b["id"], 3000)

s = tools.sales_summary("2026-10-01", "2026-10-31")
assert s["total"] == 8000 and s["card_total"] == 5000 and s["onsite_total"] == 3000, s
print("売り上げ:", s["total"], "円")

tools.update_reservation(b["id"], time="17:00")
c = tools.cancel_reservation(a["id"])
assert c["note"], "支払い済みの取り消しには返金の注意が出るはず"
assert tools.list_reservations("2026-10-23")["count"] == 1

print("すべて通りました")
