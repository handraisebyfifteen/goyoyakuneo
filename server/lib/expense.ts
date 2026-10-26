/**
 * 経費の科目を、内容のことばから当てる（科目を言われなかったとき）。当てられなければ雑費。
 */
import type { ExpenseCategory } from "@shared/schema";

const RULES: [ExpenseCategory, RegExp][] = [
  ["rent", /家賃|賃料|テナント|rent/i],
  ["utilities", /電気|ガス|水道|光熱|electric|water|gas/i],
  ["communication", /電話|携帯|スマホ|ネット|インターネット|wi-?fi|通信|切手|郵送|phone|internet/i],
  ["travel", /電車|バス|タクシー|新幹線|ガソリン|駐車|高速|交通|train|bus|taxi|parking|fuel/i],
  ["advertising", /広告|チラシ|宣伝|ホームページ|名刺|ads?\b|flyer/i],
  ["entertainment", /接待|会食|手土産|お土産|贈答/i],
  ["outsourcing", /外注|業務委託/i],
  ["fees", /手数料|振込|決済|fee/i],
  ["training", /研修|講習|セミナー|勉強会|資格|書籍|本代|training|seminar/i],
  ["repairs", /修理|修繕|メンテナンス|repair/i],
  ["insurance", /保険|insurance/i],
  ["supplies", /タオル|シーツ|オイル|クリーム|ローション|消耗|備品|洗剤|紙|文具|ペン|ティッシュ|マスク|消毒|アルコール|ベッド|枕|towel|sheet|oil|supplies/i],
];

export function guessCategory(memo: string): ExpenseCategory {
  const m = memo.normalize("NFKC");
  return RULES.find(([, re]) => re.test(m))?.[0] ?? "other";
}
