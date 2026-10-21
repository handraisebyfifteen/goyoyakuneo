"""
ご予約ちゃん — 計算層（ツール群）

AI は使わない。予約・メニュー・売り上げの計算と保存はすべてここで行う。
音声・画面・CLI のどの入口からも、この関数たちを呼ぶだけにする。

状態は JSON ファイル1枚（data.json）。DB は使わない。
data.json にはお客さんの名前が入るので、公開リポジトリには入れないこと（.gitignore 済み）。

国・通貨・時間帯・言語は最初の設定（settings）で決め、すべてそれに従う。
金額は内部では「最小単位の整数」で持つ（円なら1円、ドルなら1セント）。
ツールの出入り口では普通の金額（5000円、50.00ドル）で受け渡す。
"""

import json
import os
import uuid
from datetime import date, datetime, timedelta
from decimal import Decimal, ROUND_HALF_UP
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

DATA_FILE = os.environ.get("GOYOYAKU_DATA", "data.json")

DEFAULT_SETTINGS = {
    "country": "JP",           # 国（ISO 3166 の2文字）
    "currency": "JPY",         # 通貨（ISO 4217 の3文字）
    "timezone": "Asia/Tokyo",  # 時間帯（IANA の名前）
    "language": "ja-JP",       # 音声認識・読み上げの言語
}

# 小数のない通貨（Stripe の扱いに合わせる）
ZERO_DECIMAL = {"JPY", "KRW", "VND", "CLP", "ISK", "UGX", "PYG", "XAF", "XOF", "XPF",
                "BIF", "DJF", "GNF", "KMF", "MGA", "RWF", "VUV"}
SYMBOLS = {"JPY": "¥", "USD": "$", "EUR": "€", "GBP": "£", "KRW": "₩", "AUD": "A$", "CAD": "C$"}

PAYMENT_METHODS = ("card", "onsite")  # カード前払い / 現地払い
# 支払い状況: unpaid（カード未払い）→ paid（カード支払い済み）
#            onsite_pending（現地払い予定）→ onsite_received（現地で受け取り済み）
# 取り消し: cancelled
PAID_STATUSES = ("paid", "onsite_received")
HONORIFICS = ("さん", "様", "さま")


# ---------- 保存と読み込み ----------

def _empty():
    return {"settings": dict(DEFAULT_SETTINGS), "menus": [], "reservations": [], "days_off": []}


def _load():
    if not os.path.exists(DATA_FILE):
        return _empty()
    with open(DATA_FILE, encoding="utf-8") as f:
        data = json.load(f)
    data.setdefault("settings", dict(DEFAULT_SETTINGS))
    return data


def _save(data):
    # 一時ファイルに書いてから置き換える（途中で止まっても元のファイルが壊れない）
    tmp = DATA_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    os.replace(tmp, DATA_FILE)


# ---------- お金の道具 ----------

def _decimals(currency):
    return 0 if currency in ZERO_DECIMAL else 2


def _to_minor(amount, currency):
    """普通の金額 → 最小単位の整数（5000円→5000、50.5ドル→5050）"""
    d = Decimal(str(amount))
    return int((d * (10 ** _decimals(currency))).quantize(Decimal("1"), rounding=ROUND_HALF_UP))


def _to_major(minor, currency):
    """最小単位の整数 → 普通の金額"""
    n = _decimals(currency)
    return minor if n == 0 else float(Decimal(minor) / (10 ** n))


def _fmt(minor, currency):
    n = _decimals(currency)
    number = f"{minor:,}" if n == 0 else f"{Decimal(minor) / (10 ** n):,.{n}f}"
    sym = SYMBOLS.get(currency)
    return f"{sym}{number}" if sym else f"{number} {currency}"


def _money(minor, currency):
    return {"amount": _to_major(minor, currency), "display": _fmt(minor, currency)}


# ---------- 時間の道具 ----------

def now(data=None):
    """設定した時間帯での現在時刻（サーバーの時計の時間帯に左右されない）"""
    tz = (data or _load())["settings"]["timezone"]
    return datetime.now(ZoneInfo(tz))


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


def _clean_name(name):
    name = (name or "").strip()
    for suffix in HONORIFICS:
        if name.endswith(suffix) and len(name) > len(suffix):
            return name[: -len(suffix)].strip()
    return name


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


def _view(r):
    """外に返すときは、金額を普通の形と読み上げ用の形にする"""
    v = dict(r)
    v["price"] = _money(r["price"], r["currency"])
    v["amount_received"] = _money(r["amount_received"], r["currency"])
    return v


def _menu_view(m):
    v = dict(m)
    v["price"] = _money(m["price"], m["currency"])
    return v


# ---------- ツール0: 設定 ----------

def get_settings():
    return {"ok": True, "settings": _load()["settings"]}


def update_settings(country=None, currency=None, timezone=None, language=None):
    data = _load()
    s = data["settings"]
    if country:
        if len(country) != 2 or not country.isalpha():
            raise ValueError("国は2文字の国コードで指定してください（例: JP, US）")
        s["country"] = country.upper()
    if currency:
        currency = currency.upper()
        if len(currency) != 3 or not currency.isalpha():
            raise ValueError("通貨は3文字の通貨コードで指定してください（例: JPY, USD）")
        if currency != s["currency"] and (data["menus"] or data["reservations"]):
            raise ValueError("メニューや予約がある状態では、通貨は変えられません")
        s["currency"] = currency
    if timezone:
        try:
            ZoneInfo(timezone)
        except (ZoneInfoNotFoundError, ValueError):
            raise ValueError(f"時間帯の名前が正しくありません: {timezone}（例: Asia/Tokyo）")
        s["timezone"] = timezone
    if language:
        s["language"] = language
    _save(data)
    return {"ok": True, "settings": s}


# ---------- ツール1: 予約を見る ----------

def list_reservations(date=None, customer_name=None):
    data = _load()
    if date:
        _check_date(date)
    name = _clean_name(customer_name) if customer_name else None
    items = [
        r for r in data["reservations"]
        if r["status"] != "cancelled"
        and (date is None or r["date"] == date)
        and (name is None or name in r["customer_name"])
    ]
    items.sort(key=lambda r: (r["date"], r["time"]))
    return {"ok": True, "count": len(items), "reservations": [_view(r) for r in items],
            "is_day_off": bool(date and date in data["days_off"])}


# ---------- ツール2: 予約を入れる・変える・取り消す ----------

def add_reservation(date, time, menu_name, customer_name, payment_method):
    customer_name = _clean_name(customer_name)
    if not customer_name:
        raise ValueError("お客さんのお名前が必要です")
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
        "currency": menu["currency"],
        "customer_name": customer_name,
        "payment_method": payment_method,
        "status": "unpaid" if payment_method == "card" else "onsite_pending",
        "amount_received": 0,
        "created_at": now(data).isoformat(timespec="seconds"),
    }
    data["reservations"].append(r)
    _save(data)
    return {"ok": True, "reservation": _view(r)}


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
    if menu and r["status"] == "paid" and menu["price"] != r["price"]:
        raise ValueError("支払い済みの予約は、料金の違うメニューに変更できません")
    minutes = menu["minutes"] if menu else r["minutes"]
    _check_free(data, new_date, new_time, minutes, ignore_id=r["id"])
    r["date"], r["time"] = new_date, new_time
    if menu:
        r["menu_name"], r["minutes"], r["price"] = menu["name"], menu["minutes"], menu["price"]
    _save(data)
    return {"ok": True, "reservation": _view(r)}


def cancel_reservation(reservation_id):
    data = _load()
    r = _find_reservation(data, reservation_id)
    if r["status"] == "cancelled":
        raise ValueError("この予約はすでに取り消されています")
    was_paid = r["status"] == "paid"
    r["status"] = "cancelled"
    _save(data)
    note = "カードで支払い済みのため、返金はマッサージ師ご本人が行ってください" if was_paid else ""
    return {"ok": True, "reservation": _view(r), "note": note}


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
    minutes = int(minutes)
    data = _load()
    currency = data["settings"]["currency"]
    price_minor = _to_minor(price, currency)
    if minutes <= 0 or price_minor < 0:
        raise ValueError("時間は1分以上、料金は0以上にしてください")
    if any(m["name"] == name for m in data["menus"]):
        raise ValueError(f"「{name}」というメニューはすでにあります")
    m = {"name": name, "minutes": minutes, "price": price_minor, "currency": currency}
    data["menus"].append(m)
    _save(data)
    return {"ok": True, "menu": _menu_view(m)}


def list_menus():
    return {"ok": True, "menus": [_menu_view(m) for m in _load()["menus"]]}


# ---------- ツール5: 売り上げを集計する ----------

def sales_summary(start_date, end_date):
    _check_date(start_date)
    _check_date(end_date)
    data = _load()
    cur = data["settings"]["currency"]
    rs = [r for r in data["reservations"] if start_date <= r["date"] <= end_date]
    card = sum(r["amount_received"] for r in rs if r["status"] == "paid")
    onsite = sum(r["amount_received"] for r in rs if r["status"] == "onsite_received")
    waiting = [r for r in rs if r["status"] in ("unpaid", "onsite_pending")]
    return {
        "ok": True,
        "start_date": start_date,
        "end_date": end_date,
        "currency": cur,
        "total": _money(card + onsite, cur),
        "card_total": _money(card, cur),
        "onsite_total": _money(onsite, cur),
        "paid_count": sum(1 for r in rs if r["status"] in PAID_STATUSES),
        "waiting_count": len(waiting),
        "waiting_amount": _money(sum(r["price"] for r in waiting), cur),
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
                "currency": r["currency"].lower(),
                "product_data": {"name": f"{r['menu_name']}（{r['date']} {r['time']}）"},
                "unit_amount": r["price"],  # 最小単位の整数（円なら円、ドルならセント）
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
    return {"ok": True, "reservation": _view(r)}


# ---------- ツール7: 現地払いの受け取りを記録する ----------

def record_onsite_payment(reservation_id, amount):
    data = _load()
    r = _find_reservation(data, reservation_id)
    if r["status"] != "onsite_pending":
        raise ValueError("この予約は現地払い待ちの状態ではありません")
    amount_minor = _to_minor(amount, r["currency"])
    if amount_minor <= 0:
        raise ValueError("受け取った金額は0より大きくしてください")
    r["status"] = "onsite_received"
    r["amount_received"] = amount_minor
    _save(data)
    note = "" if amount_minor == r["price"] else \
        f"料金{_fmt(r['price'], r['currency'])}と受け取り額{_fmt(amount_minor, r['currency'])}が違います"
    return {"ok": True, "reservation": _view(r), "note": note}
