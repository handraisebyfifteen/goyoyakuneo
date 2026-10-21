"""
ご予約ちゃん — CLI の入口

文字で話しかけて、一周動くか確かめるためのもの。
あとで音声・画面の入口を足しても、中身（agent.py / tools.py）は同じものを使う。
"""

from agent import run

YES = ("はい", "うん", "お願いします", "おねがいします", "yes", "y")


def confirm(question):
    print(f"ご予約ちゃん: {question}")
    answer = input("あなた（はい／いいえ）: ").strip().lower()
    return answer in YES


def main():
    print("ご予約ちゃん（CLI版）です。「終わり」で終了します。")
    history = []
    while True:
        text = input("あなた: ").strip()
        if not text:
            continue
        if text in ("終わり", "おわり", "exit", "quit"):
            print("ご予約ちゃん: お疲れさまでした。")
            break
        print(f"ご予約ちゃん: {run(text, history, confirm)}")


if __name__ == "__main__":
    main()
