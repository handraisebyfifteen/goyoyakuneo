"""
ご予約ちゃん — 計算層（ツール群）

AI は使わない。予約・メニュー・売り上げの計算と保存はすべてここで行う。
音声・画面・CLI のどの入口からも、この関数たちを呼ぶだけにする。

状態は JSON ファイル1枚（data.json）。DB は使わない。
data.json にはお客さんの名前が入るので、公開リポジトリには入れないこと（.gitignore 済み）。
"""

import json
import os
import uuid
from datetime import date, datetime, timedelta

DATA_FILE = os.environ.get("GOYOYAKU_DATA", "data.json")

PAYMENT_METHODS = ("card", "onsite")  # カード前払い / 現地払い
# 支払い状況: unpaid（カード未払い）→ paid（カード支払い済み）
#            onsite_pending（現地払い予定）→ onsite_received（現地で受け取り済み）
# 取り消し: cancelled
PAID_STATUSES = ("paid", "onsite_received")


# ---------- 保存と読み込み ----------

def _empty():
    return {"menus": [], "reservations": [], "days_off": []}


def _load():
    if not os.path.exists(DATA_FILE):
        return _empty()
    with open(DATA_FILE, encoding="utf-8") as f:
        return json.load(f)


def _save(data):
    # 一時ファイルに書いてから置き換える（途中で止まっても元のファイルが壊れない）
    tmp = DATA_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    os.replace(tmp, DATA_FILE)


# ---------- 小さな道具 ----------

def _check_date(d):
    try:
        date.fromisoformat(d)
    except (TypeError, ValueError):
        raise ValueError(f"日付の形が正しくありません: {d}（例: 2026-10-23）")


def _check_time(t):
    try:
        datetime.strptime(t, "%H:%M")
    except (TypeError, ValueError):
        raise ValueError(f"時刻の形が正しくありません: {t}（例: 15:00）")


def _find_menu(data, name):
    for m in data["menus"]:
        if m["name"] == name:
            return m
    names = "、".join(m["name"] for m in data["menus"]) or "（まだありません）"
    raise ValueError(f"「{name}」というメニューはありません。今あるメニュー: {names}")


def _find_reservation(data, reservation_id):
    for r in data["reservations"]:
        if r["id"] == reservation_id:
            return r
    raise ValueError(f"予約番号 {reservation_id} は見つかりません")


def _span(d, t, minutes):
    start = datetime.fromisoformat(f"{d}T{t}")
    return start, start + timedelta(minutes=minutes)


def _check_free(data, d, t, minutes, ignore_id=None):
    if d in data["days_off"]:
        raise ValueError(f"{d} はお休みの日です")
    new_start, new_end = _span(d, t, minutes)
    for r in data["reservations"]:
        if r["id"] == ignore_id or r["status"] == "cancelled" or r["date"] != d:
            continue
        s, e = _span(r["date"], r["time"], r["minutes"])
        if new_start < e and s < new_end:
            raise ValueError(f"{r['time']}からの{r['customer_name']}様の予約と時間が重なります")


# ---------- ツール1: 予約を見る ----------

def list_reservations(date=None, customer_name=None):
    data = _load()
    if date:
        _check_date(date)
    items = [
        r for r in data["reservations"]
        if r["status"] != "cancelled"
        and (date is None or r["date"] == date)
        and (customer_name is None or customer_name in r["customer_name"])
    ]
    items.sort(key=lambda r: (r["date"], r["time"]))
    return {"ok": True, "count": len(items), "reservations": items,
            "is_day_off": bool(date and date in data["days_off"])}


# ---------- ツール2: 予約を入れる・変える・取り消す ----------

def add_reservation(date, time, menu_name, customer_name, payment_method):
    _check_date(date)
    _check_time(time)
    if payment_method not in PAYMENT_METHODS:
        raise ValueError("支払い方法は card（カード前払い）か onsite（現地払い）です")
    data = _load()
    menu = _find_menu(data, menu_name)
    _check_free(data, date, time, menu["minutes"])
    r = {
        "id": uuid.uuid4().hex[:6],
        "date": date,
        "time": time,
        "menu_name": menu["name"],
        "minutes": menu["minutes"],
        "price": menu["price"],
        "customer_name": customer_name,
        "payment_method": payment_method,
        "status": "unpaid" if payment_method == "card" else "onsite_pending",
        "amount_received": 0,
        "created_at": datetime.now().isoformat(timespec="seconds"),
    }
    data["reservations"].append(r)
    _save(data)
    return {"ok": True, "reservation": r}


def update_reservation(reservation_id, date=None, time=None, menu_name=None):
    data = _load()
    r = _find_reservation(data, reservation_id)
    if r["status"] == "cancelled":
        raise ValueError("取り消し済みの予約は変更できません")
    new_date = date or r["date"]
    new_time = time or r["time"]
    _check_date(new_date)
    _check_time(new_time)
    menu = _find_menu(data, menu_name) if menu_name else None
    minutes = menu["minutes"] if menu else r["minutes"]
    _check_free(data, new_date, new_time, minutes, ignore_id=r["id"])
    r["date"], r["time"] = new_date, new_time
    if menu:
        if r["status"] == "paid" and menu["price"] != r["price"]:
            raise ValueError("支払い済みの予約は、料金の違うメニューに変更できません")
        r["menu_name"], r["minutes"], r["price"] = menu["name"], menu["minutes"], menu["price"]
    _save(data)
    return {"ok": True, "reservation": r}


def cancel_reservation(reservation_id):
    data = _load()
    r = _find_reservation(data, reservation_id)
    if r["status"] == "cancelled":
        raise ValueError("この予約はすでに取り消されています")
    was_paid = r["status"] == "paid"
    r["status"] = "cancelled"
    _save(data)
    note = "カードで支払い済みのため、返金はマッサージ師ご本人が行ってください" if was_paid else ""
    return {"ok": True, "reservation": r, "note": note}


# ---------- ツール3: 休みを入れる ----------

def add_day_off(date):
    _check_date(date)
    data = _load()
    clash = [r for r in data["reservations"] if r["date"] == date and r["status"] != "cancelled"]
    if clash:
        names = "、".join(f"{r['time']} {r['customer_name']}様" for r in clash)
        raise ValueError(f"{date} には予約があります（{names}）。先に予約を変更してください")
    if date not in data["days_off"]:
        data["days_off"].append(date)
        data["days_off"].sort()
        _save(data)
    return {"ok": True, "days_off": data["days_off"]}


# ---------- ツール4: メニューを作る・見る ----------

def create_menu(name, minutes, price):
    minutes, price = int(minutes), int(price)
    if minutes <= 0 or price < 0:
        raise ValueError("時間は1分以上、料金は0円以上にしてください")
    data = _load()
    if any(m["name"] == name for m in data["menus"]):
        raise ValueError(f"「{name}」というメニューはすでにあります")
    m = {"name": name, "minutes": minutes, "price": price}
    data["menus"].append(m)
    _save(data)
    return {"ok": True, "menu": m}


def list_menus():
    return {"ok": True, "menus": _load()["menus"]}


# ---------- ツール5: 売り上げを集計する ----------

def sales_summary(start_date, end_date):
    _check_date(start_date)
    _check_date(end_date)
    data = _load()
    rs = [r for r in data["reservations"] if start_date <= r["date"] <= end_date]
    card = sum(r["amount_received"] for r in rs if r["status"] == "paid")
    onsite = sum(r["amount_received"] for r in rs if r["status"] == "onsite_received")
    waiting = [r for r in rs if r["status"] in ("unpaid", "onsite_pending")]
    return {
        "ok": True,
        "start_date": start_date,
        "end_date": end_date,
        "total": card + onsite,
        "card_total": card,
        "onsite_total": onsite,
        "paid_count": sum(1 for r in rs if r["status"] in PAID_STATUSES),
        "waiting_count": len(waiting),
        "waiting_amount": sum(r["price"] for r in waiting),
        "cancelled_count": sum(1 for r in rs if r["status"] == "cancelled"),
    }


# ---------- ツール6: 決済リンクを作る（Stripe テストモード） ----------

def create_payment_link(reservation_id):
    data = _load()
    r = _find_reservation(data, reservation_id)
    if r["payment_method"] != "card":
        raise ValueError("この予約は現地払いです")
    if r["status"] != "unpaid":
        raise ValueError("この予約は支払いが必要な状態ではありません")

    key = os.environ.get("STRIPE_SECRET_KEY")
    if not key:
        # キー未設定でも一周できるように、仮のリンクを返す
        r["payment_url"] = f"https://example.com/pay/{r['id']}"
        _save(data)
        return {"ok": True, "url": r["payment_url"], "note": "Stripeのキーが未設定のため仮のリンクです"}
    if not key.startswith("sk_test_"):
        # 安全のため、本番用のキーでは動かさない
        raise ValueError("テスト用のキー（sk_test_ で始まるもの）以外は使えません")

    import stripe
    stripe.api_key = key
    session = stripe.checkout.Session.create(
        mode="payment",
        line_items=[{
            "price_data": {
                "currency": "jpy",
                "product_data": {"name": f"{r['menu_name']}（{r['date']} {r['time']}）"},
                "unit_amount": r["price"],  # 円は小数がないので、そのままの金額
            },
            "quantity": 1,
        }],
        success_url="https://example.com/thanks",
        metadata={"reservation_id": r["id"]},
    )
    r["payment_url"] = session.url
    r["stripe_session_id"] = session.id
    _save(data)
    return {"ok": True, "url": session.url}


def mark_card_paid(reservation_id):
    """Stripe から支払い完了の知らせが来たときに呼ぶ（AI からは呼ばない）"""
    data = _load()
    r = _find_reservation(data, reservation_id)
    if r["status"] != "unpaid":
        raise ValueError("この予約は未払いの状態ではありません")
    r["status"] = "paid"
    r["amount_received"] = r["price"]
    _save(data)
    return {"ok": True, "reservation": r}


# ---------- ツール7: 現地払いの受け取りを記録する ----------

def record_onsite_payment(reservation_id, amount):
    amount = int(amount)
    data = _load()
    r = _find_reservation(data, reservation_id)
    if r["status"] != "onsite_pending":
        raise ValueError("この予約は現地払い待ちの状態ではありません")
    if amount <= 0:
        raise ValueError("受け取った金額は1円以上にしてください")
    r["status"] = "onsite_received"
    r["amount_received"] = amount
    _save(data)
    note = "" if amount == r["price"] else f"料金{r['price']}円と受け取り額が違います"
    return {"ok": True, "reservation": r, "note": note}
