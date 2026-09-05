import type { Analyzer, Ctx, AnalyzerResult, Derived, Step } from "../types.ts";
import { scanEmbedded } from "../magic.ts";
import { hx } from "../bytes.ts";

/**
 * binwalk相当。ファイル中に別ファイルのマジックバイトが現れる箇所を探し、
 * そこから末尾までを切り出して(carve)再帰解析に回す。
 */
export const embedded: Analyzer = {
  name: "embedded",
  genre: "forensics",
  applies: (ctx) => ctx.node.bytes.length > 32,
  run(ctx: Ctx): AnalyzerResult {
    const b = ctx.node.bytes;
    // 既に専用アナライザが説明済みの範囲は除外する。
    // ZIPのローカルヘッダやPNGのチャンクは「埋め込み」ではなく正規の構造。
    const raw = scanEmbedded(b, true);
    const hits = raw.filter((h) => ctx.isClaimed(h.offset) === null);
    const suppressed = raw.length - hits.length;
    const steps: Step[] = [];
    const derived: Derived[] = [];

    if (hits.length === 0) {
      steps.push({
        id: ctx.nextId(), analyzer: "embedded", genre: "forensics",
        title: "埋め込みファイルの痕跡なし",
        observation: "先頭以外の位置に、既知形式のマジックバイトは検出されなかった",
        reasoning: "ファイルの中に別のファイルを丸ごと隠す手口は定番なので必ず確認する。無いと分かれば構造解析やステガノに進める。",
        action: "全オフセットに対して既知シグネチャを走査した",
        command: "binwalk chal.bin",
        outcome: suppressed ? `検出ゼロ（${suppressed}件は正規の構造の一部として除外）` : "検出ゼロ",
        confidence: 0.3,
      });
      return { steps, derived, flags: [] };
    }

    // 同一形式が密集する場合は先頭のみ採用（誤検出の氾濫を防ぐ）
    const picked = dedupe(hits);
    const listing = picked.map((h) => `${hx(h.offset)} に ${h.sig.label}`).join("、");

    const sid = ctx.nextId();
    steps.push({
      id: sid, analyzer: "embedded", genre: "forensics",
      title: `別ファイルの埋め込みを ${picked.length} 箇所検出`,
      observation: listing,
      reasoning:
        "本来そのファイル形式には現れないはずのマジックバイトが途中に出てくるのは、" +
        "別のファイルが連結・埋め込みされている強い証拠。画像の末尾にZIPを繋げる手口はCTF最頻出の一つ。",
      action: "各検出位置からファイル末尾までを切り出し、独立したファイルとして扱う",
      command: "binwalk -e chal.bin   # -e で自動抽出",
      outcome: `${picked.length} 個のデータ塊を抽出。それぞれを再帰的に解析する`,
      confidence: 0.85,
      learn:
        "多くの形式は『先頭から読んで終端マーカーで止まる』ため、末尾に余計なデータを足しても画像は普通に開ける。" +
        "見た目が正常なことは、中身が正常であることを意味しない。",
    });

    for (const h of picked) {
      derived.push({
        label: `${hx(h.offset)}から切り出した${h.sig.label}`,
        bytes: b.subarray(h.offset),
        fromStepId: sid,
        recurse: true,
      });
    }
    return { steps, derived, flags: [] };
  },
};

function dedupe(hits: ReturnType<typeof scanEmbedded>) {
  const byId = new Map<string, number>();
  const out: typeof hits = [];
  for (const h of hits) {
    const n = byId.get(h.sig.id) ?? 0;
    if (n >= 2) continue; // 同形式は2個まで
    byId.set(h.sig.id, n + 1);
    out.push(h);
    if (out.length >= 8) break;
  }
  return out;
}
