"""
計算層だけのテスト（AI もネットも使わない）。
実行: python test_tools.py
"""

import importlib
import os
import tempfile

os.environ.pop("STRIPE_SECRET_KEY", None)


def fresh_tools():
    """毎回まっさらな一時ファイルで tools を読み込み直す（本番の data.json には触らない）"""
    os.environ["GOYOYAKU_DATA"] = os.path.join(tempfile.mkdtemp(), "test.json")
    import tools
    return importlib.reload(tools)


def expect_error(fn, *args, **kwargs):
    try:
        fn(*args, **kwargs)
    except ValueError as e:
        print("  正しく止まりました:", e)
        return
    raise AssertionError("止まるはずが通ってしまいました")


# ===== 日本・円 =====
tools = fresh_tools()
assert tools.get_settings()["settings"]["currency"] == "JPY"

tools.create_menu("60分コース", 60, 5000)
tools.create_menu("30分コース", 30, 3000)

a = tools.add_reservation("2026-10-23", "15:00", "60分コース", "田中さん", "card")["reservation"]
b = tools.add_reservation("2026-10-23", "16:00", "30分コース", "佐藤様", "onsite")["reservation"]
assert a["customer_name"] == "田中" and b["customer_name"] == "佐藤", "敬称が取れていない"
assert a["price"]["display"] == "¥5,000", a["price"]

print("重なる予約:")
expect_error(tools.add_reservation, "2026-10-23", "15:30", "30分コース", "鈴木", "onsite")

print("予約のある日を休みに:")
expect_error(tools.add_day_off, "2026-10-23")
tools.add_day_off("2026-10-24")
print("休みの日に予約:")
expect_error(tools.add_reservation, "2026-10-24", "10:00", "30分コース", "鈴木", "onsite")

print("予約があるのに通貨を変える:")
expect_error(tools.update_settings, currency="USD")

assert tools.create_payment_link(a["id"])["ok"]
tools.mark_card_paid(a["id"])
tools.record_onsite_payment(b["id"], 3000)

s = tools.sales_summary("2026-10-01", "2026-10-31")
assert s["total"]["amount"] == 8000 and s["card_total"]["amount"] == 5000, s
print("売り上げ（円）:", s["total"]["display"])

assert tools.list_reservations(customer_name="田中さん")["count"] == 1, "敬称つきで検索できない"
tools.update_reservation(b["id"], time="17:00")
c = tools.cancel_reservation(a["id"])
assert c["note"], "支払い済みの取り消しには返金の注意が出るはず"
assert tools.list_reservations("2026-10-23")["count"] == 1

# ===== アメリカ・ドル =====
tools = fresh_tools()
tools.update_settings(country="US", currency="usd", timezone="America/New_York", language="en-US")
print("存在しない時間帯:")
expect_error(tools.update_settings, timezone="Mars/Olympus")

m = tools.create_menu("60 min massage", 60, 49.99)["menu"]
assert m["price"]["display"] == "$49.99", m["price"]

r = tools.add_reservation("2026-10-23", "10:00", "60 min massage", "Smith", "onsite")["reservation"]
note = tools.record_onsite_payment(r["id"], 50)["note"]
assert note, "金額の違いを知らせるはず"

s = tools.sales_summary("2026-10-01", "2026-10-31")
assert s["total"]["amount"] == 50.0 and s["total"]["display"] == "$50.00", s
print("売り上げ（ドル）:", s["total"]["display"])

# 時間帯で「今日」が変わること
assert str(tools.now().tzinfo) == "America/New_York"

print("すべて通りました")
