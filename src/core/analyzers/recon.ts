import type { Analyzer, Ctx, AnalyzerResult } from "../types.ts";
import { entropy, hexdump, hex, extractStrings } from "../bytes.ts";

/** 最初の一手: 何のファイルかを確定させる。全ての解析はここから始まる */
export const recon: Analyzer = {
  name: "recon",
  genre: "recon",
  applies: () => true,
  run(ctx: Ctx): AnalyzerResult {
    const b = ctx.node.bytes;
    const k = ctx.node.kind;
    const h = entropy(b);

    const id = ctx.nextId();
    const steps = [{
      id, analyzer: "recon", genre: "recon" as const,
      title: `ファイル種別の特定 → ${k.label}`,
      observation: `サイズ ${b.length.toLocaleString()} バイト。先頭16バイトは ${hex(b, 0, 16)}`,
      reasoning:
        "拡張子は誰でも詐称できるので信用しない。ファイル形式は先頭の『マジックバイト』で決まる。" +
        "CTFでは拡張子とマジックバイトが食い違うこと自体が問題の仕掛けであることも多い。",
      action: "先頭バイト列を既知のシグネチャ表と照合した",
      command: "file chal.bin && xxd chal.bin | head",
      outcome: `${k.label} と判定（根拠: ${k.evidence}）`,
      confidence: 0.9,
      learn: "マジックバイトは各形式の先頭に置かれた固定の目印。PNGなら 89 50 4E 47、ZIPなら 50 4B 03 04（\"PK\"）。",
    }];

    // エントロピーは「隠されているか」の粗い指標になる
    const eid = ctx.nextId();
    let verdict: string, why: string, conf: number;
    if (h > 7.5) {
      verdict = "非常に高い。暗号化または圧縮済みの可能性が高い";
      why = "ランダムに近いバイト分布は、圧縮か暗号化を通した後の姿。生のテキストや素の画像データではまず出ない値。";
      conf = 0.7;
    } else if (h < 1.5) {
      verdict = "非常に低い。同じ値の繰り返しが支配的";
      why = "極端に偏った分布は、パディングや単純なパターン埋め込みを示唆する。";
      conf = 0.5;
    } else {
      verdict = "中程度。テキストや通常の構造化データの範囲";
      why = "この帯域は素のテキスト・非圧縮のデータ構造でよく見られる。特筆すべき異常ではない。";
      conf = 0.3;
    }
    steps.push({
      id: eid, analyzer: "recon", genre: "recon" as const,
      title: `エントロピー ${h.toFixed(2)} bits/byte — ${verdict.split("。")[0]}`,
      observation: `バイト分布のシャノンエントロピーは ${h.toFixed(3)}（最大8.0）`,
      reasoning: why,
      action: "全バイトの出現頻度からエントロピーを算出した",
      command: "binwalk -E chal.bin   # エントロピーの推移をグラフ化",
      outcome: verdict,
      confidence: conf,
      learn: "エントロピーは『情報の詰まり具合』。8.0に近い＝予測できない＝圧縮/暗号化済み。ファイル内で急に上がる区間があれば、そこに何か埋まっている。",
    });

    const strs = extractStrings(b, 6, 2000);
    if (strs.length > 0) {
      steps.push({
        id: ctx.nextId(), analyzer: "recon", genre: "recon" as const,
        title: `可読文字列を ${strs.length} 件抽出`,
        observation: `例: ${strs.slice(0, 5).map((s) => JSON.stringify(s.text.slice(0, 48))).join(", ")}`,
        reasoning: "バイナリ中に残る文字列は最も安上がりな手がかり。フラグそのもの、ヒント、使用ツール名、埋め込みファイル名が現れることがある。",
        action: "6文字以上の連続する印字可能文字を全て抜き出した",
        command: "strings -n 6 chal.bin | less",
        outcome: `${strs.length} 件（先頭のプレビューは上記）`,
        confidence: 0.4,
        learn: "stringsは最初に打つコマンドの定番。何も出なければ『圧縮/暗号化されている』という情報が得られる。",
      });
    }

    return { steps, derived: [], flags: [] };
  },
};

export function preview(b: Uint8Array): string { return hexdump(b, 0, 96); }
