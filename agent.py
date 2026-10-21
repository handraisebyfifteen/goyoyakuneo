"""
ご予約ちゃん — Nemotron とつなぐ部分

- Super:     毎回の発話を読んで、どのツールを呼ぶか決める（Lightning はツールを呼ばずに作り話をするので使わない）
- Super:     お金や予約が変わる操作の前に、本人に読み上げる確認文を作る

お金や予約が変わるツールは、本人が「はい」と言うまで実行しない。
「承りました」は、保存に成功した後にだけ言う。
"""

import json
import os
import re
from datetime import datetime

from openai import OpenAI

import tools

client = OpenAI(
    base_url="https://api.tokenfactory.nebius.com/v1/",
    api_key=os.environ["NEBIUS_API_KEY"],
)

SMART_MODEL = "nvidia/nemotron-3-super-120b-a12b"
# ツール選択も Super に任せる。Lightning は「明日の予約は？」「今月の売り上げは？」で
# ツールを呼ばずに会話の記憶から予約や金額を作って答えることが多かった（8回中7回）。
# tool_choice="required" で強制すると1回の返答にツール呼び出しが数百個並び、
# 挨拶しただけで書き込み系の確認が出たので、それも使えない。
# Super は毎回ツールを呼び、1問3〜5秒だった（2026-10-21 に確認）。
FAST_MODEL = SMART_MODEL

READ_TOOLS = {"get_settings", "list_reservations", "list_menus", "sales_summary"}
WRITE_TOOLS = {
    "update_settings",
    "add_reservation", "update_reservation", "cancel_reservation",
    "add_day_off", "create_menu", "create_payment_link", "record_onsite_payment",
}

WEEKDAYS = "月火水木金土日"


def _fn(name, description, properties=None, required=None):
    return {
        "type": "function",
        "function": {
            "name": name,
            "description": description,
            "parameters": {
                "type": "object",
                "properties": properties or {},
                "required": required or [],
            },
        },
    }


DATE = {"type": "string", "description": "日付 YYYY-MM-DD"}
TIME = {"type": "string", "description": "時刻 HH:MM（24時間）"}
RID = {"type": "string", "description": "予約番号（list_reservations で調べる）"}

TOOL_SPECS = [
    _fn("get_settings", "国・通貨・時間帯・言語の設定を見る。"),
    _fn("update_settings", "国・通貨・時間帯・言語の設定を変える。最初の設定で使う。",
        {"country": {"type": "string", "description": "国コード2文字（例: JP, US）"},
         "currency": {"type": "string", "description": "通貨コード3文字（例: JPY, USD）"},
         "timezone": {"type": "string", "description": "時間帯（例: Asia/Tokyo, America/New_York）"},
         "language": {"type": "string", "description": "言語（例: ja-JP, en-US）"}}),
    _fn("list_reservations", "予約を見る。日付やお客さんの名前で絞れる。",
        {"date": DATE, "customer_name": {"type": "string"}}),
    _fn("add_reservation", "予約を入れる。",
        {"date": DATE, "time": TIME, "menu_name": {"type": "string"},
         "customer_name": {"type": "string"},
         "payment_method": {"type": "string", "enum": ["card", "onsite"],
                            "description": "card=カード前払い, onsite=現地払い"}},
        ["date", "time", "menu_name", "customer_name", "payment_method"]),
    _fn("update_reservation", "予約の日時やメニューを変える。",
        {"reservation_id": RID, "date": DATE, "time": TIME, "menu_name": {"type": "string"}},
        ["reservation_id"]),
    _fn("cancel_reservation", "予約を取り消す。", {"reservation_id": RID}, ["reservation_id"]),
    _fn("add_day_off", "お休みの日を入れる。", {"date": DATE}, ["date"]),
    _fn("create_menu", "メニューを作る。",
        {"name": {"type": "string"}, "minutes": {"type": "integer"},
         "price": {"type": "number", "description": "設定した通貨での普通の金額（例: 5000円なら5000、50ドルなら50）"}},
        ["name", "minutes", "price"]),
    _fn("list_menus", "メニューの一覧を見る。"),
    _fn("sales_summary", "期間の売り上げを集計する。",
        {"start_date": DATE, "end_date": DATE}, ["start_date", "end_date"]),
    _fn("create_payment_link", "カード前払いの予約に、お客さん用の支払いリンクを作る。",
        {"reservation_id": RID}, ["reservation_id"]),
    _fn("record_onsite_payment", "現地払いでお金を受け取ったことを記録する。",
        {"reservation_id": RID, "amount": {"type": "number", "description": "受け取った金額（設定した通貨での普通の金額）"}},
        ["reservation_id", "amount"]),
]


def _system_prompt():
    s = tools.get_settings()["settings"]
    now = tools.now()  # 設定した時間帯の現在時刻（サーバーの時計に左右されない）
    today = f"{now:%Y-%m-%d %H:%M}（{WEEKDAYS[now.weekday()]}曜日）"
    return f"""あなたは「ご予約ちゃん」です。目の不自由なマッサージ師の方の、予約と売り上げの管理を音声で手伝います。
現在は {today}、時間帯は {s['timezone']} です。「明日」「来週の木曜」などはこの日付から計算してください。
国は {s['country']}、通貨は {s['currency']}、話す言語は {s['language']} です。
金額はツールの結果にある display の形で読み上げてください。

守ること:
- 返事はすべて読み上げられます。短く、丁寧な日本語で。記号・表・箇条書き・絵文字は使わない。
- 予約番号などの英数字は読み上げない。お客さんの名前と日時で話す。
- 予約や金額は、必ずツールで調べてから答える。推測で答えない。
- ツールの結果が ok: true のときだけ「承りました」と言う。失敗したら理由をそのまま伝える。
- 本人が取り消した操作は、実行されていないと伝える。
- カード番号などの支払い情報は、聞かない・言わない。"""


def _strip_thinking(text):
    return re.sub(r"<think>.*?</think>", "", text or "", flags=re.S).strip()


def _run_tool(name, args):
    try:
        return getattr(tools, name)(**args)
    except (ValueError, TypeError) as e:
        return {"ok": False, "error": str(e)}
    except Exception as e:
        print(f"[ツールのエラー] {name}: {e!r}")  # 開発者向けの記録
        return {"ok": False, "error": "保存に失敗しました。もう一度お試しください。"}


def make_confirmation(name, args):
    """Super に、本人に読み上げる確認文を作ってもらう"""
    try:
        res = client.chat.completions.create(
            model=SMART_MODEL,
            messages=[
                {"role": "system", "content":
                    "目の不自由なマッサージ師に読み上げる確認文を、日本語で一文だけ書いてください。"
                    "「〜でよろしいでしょうか」で終えること。予約番号などの英数字は入れない。"
                    "まだ実行していないので「承りました」とは言わない。"},
                {"role": "user", "content": json.dumps({"操作": name, "内容": args}, ensure_ascii=False)},
            ],
        )
        text = _strip_thinking(res.choices[0].message.content)
        if text:
            return text
    except Exception:
        pass
    return f"{name} を実行します。よろしいでしょうか"


def run(user_text, history, confirm):
    """
    user_text: 本人の発話（文字）
    history:   これまでの会話（user / assistant のみ）
    confirm:   確認文を受け取って True / False を返す関数（CLI なら input、音声なら「はい」）
    """
    messages = [{"role": "system", "content": _system_prompt()}, *history,
                {"role": "user", "content": user_text}]

    for _ in range(6):  # ツール呼び出しの往復は最大6回
        res = client.chat.completions.create(model=FAST_MODEL, messages=messages, tools=TOOL_SPECS)
        msg = res.choices[0].message

        if not msg.tool_calls:
            reply = _strip_thinking(msg.content) or "すみません、もう一度おっしゃっていただけますか。"
            history += [{"role": "user", "content": user_text}, {"role": "assistant", "content": reply}]
            return reply

        messages.append(msg.model_dump(exclude_none=True))
        for call in msg.tool_calls:
            name = call.function.name
            try:
                args = json.loads(call.function.arguments or "{}")
            except json.JSONDecodeError:
                args = {}

            if name not in READ_TOOLS | WRITE_TOOLS:
                result = {"ok": False, "error": f"{name} というツールはありません"}
            elif name in WRITE_TOOLS and not confirm(make_confirmation(name, args)):
                result = {"ok": False, "error": "ご本人が取り消しました。実行していません。"}
            else:
                result = _run_tool(name, args)

            messages.append({"role": "tool", "tool_call_id": call.id,
                             "content": json.dumps(result, ensure_ascii=False)})

    return "すみません、うまく処理できませんでした。もう一度お願いします。"
