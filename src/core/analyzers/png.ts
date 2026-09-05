import type { Analyzer, Ctx, AnalyzerResult, Derived, Step } from "../types.ts";
import { u32be, ascii, hx } from "../bytes.ts";
import { crc32 } from "../crc32.ts";
import { findFlags } from "../flag.ts";
import { inflateZlib } from "../inflate.ts";

const STANDARD = new Set([
  "IHDR", "PLTE", "IDAT", "IEND", "tRNS", "cHRM", "gAMA", "iCCP", "sBIT",
  "sRGB", "tEXt", "zTXt", "iTXt", "bKGD", "hIST", "pHYs", "sPLT", "tIME",
  "acTL", "fcTL", "fdAT", "eXIf",
]);

interface Chunk { offset: number; length: number; type: string; dataStart: number; crcOk: boolean; declaredCrc: number; actualCrc: number; }

export const png: Analyzer = {
  name: "png",
  genre: "forensics",
  applies: (ctx) => ctx.node.kind.id === "png",
  async run(ctx: Ctx): Promise<AnalyzerResult> {
    const b = ctx.node.bytes;
    const steps: Step[] = [];
    const derived: Derived[] = [];
    const flags = [];
    const chunks: Chunk[] = [];

    let p = 8; // シグネチャの直後
    let iendEnd = -1;
    while (p + 8 <= b.length) {
      const len = u32be(b, p);
      const type = ascii(b, p + 4, 4);
      const dataStart = p + 8;
      if (len > b.length || dataStart + len + 4 > b.length) break;
      const declaredCrc = u32be(b, dataStart + len);
      const actualCrc = crc32(b, p + 4, dataStart + len); // type+data が対象
      chunks.push({ offset: p, length: len, type, dataStart, crcOk: declaredCrc === actualCrc, declaredCrc, actualCrc });
      p = dataStart + len + 4;
      if (type === "IEND") { iendEnd = p; break; }
    }

    if (iendEnd > 0) ctx.claim(0, iendEnd, "PNG本体");

    // --- 構造の全体像 ---
    const sid = ctx.nextId();
    steps.push({
      id: sid, analyzer: "png", genre: "forensics",
      title: `PNGチャンク構造を解析 — ${chunks.length} 個`,
      observation: chunks.map((c) => `${c.type}(${c.length}B)`).join(" → "),
      reasoning:
        "PNGは[長さ4][型4][データ][CRC4]のチャンクが並ぶだけの単純な構造。" +
        "順に読めば、規格外のチャンク・壊れたCRC・末尾の余剰データといった異常が全て見える。",
      action: "シグネチャ直後から順にチャンクを走査した",
      command: "pngcheck -v chal.png",
      outcome: `IHDR〜IEND を確認。ファイル長 ${b.length}、IEND終端 ${iendEnd < 0 ? "不明" : hx(iendEnd)}`,
      confidence: 0.6,
      learn: "チャンク型の1文字目が小文字なら『無視してよい補助チャンク』の意味。だから独自チャンクを埋めても画像は普通に表示される。",
    });

    // --- IEND以降の余剰データ ---
    if (iendEnd > 0 && iendEnd < b.length) {
      const extra = b.subarray(iendEnd);
      const id = ctx.nextId();
      steps.push({
        id, analyzer: "png", genre: "forensics",
        title: `IEND以降に ${extra.length} バイトの余剰データ`,
        observation: `画像データは ${hx(iendEnd)} で終わっているのに、ファイルは ${hx(b.length)} まで続く`,
        reasoning:
          "IENDはPNGの終端マーカーで、ビューアはここで読み込みをやめる。" +
          "つまりIEND以降に何を書いても画像は正常に表示される — 隠し場所として最も手軽な一等地。",
        action: "IEND以降を切り出して独立データとして解析する",
        command: "dd if=chal.png bs=1 skip=$((" + iendEnd + ")) of=hidden.bin",
        outcome: `${extra.length} バイトを抽出`,
        confidence: 0.9,
        learn: "『ファイルの正規の終端 < 実際のファイルサイズ』は、形式を問わず万能のチェック項目。JPEGならFFD9、GIFなら0x3Bが終端。",
      });
      derived.push({ label: "IEND以降の余剰データ", bytes: extra, fromStepId: id, recurse: true });
    }

    // --- CRC不一致（改竄の痕跡） ---
    for (const c of chunks.filter((c) => !c.crcOk)) {
      const isIhdr = c.type === "IHDR";
      steps.push({
        id: ctx.nextId(), analyzer: "png", genre: "forensics",
        title: `${c.type} チャンクのCRCが不一致`,
        observation: `記録されたCRC ${hx(c.declaredCrc)} に対し、実データから計算すると ${hx(c.actualCrc)}`,
        reasoning: isIhdr
          ? "IHDRには画像の幅と高さが入っている。CRCだけが合わないのは『幅や高さを後から書き換えた』典型的な痕跡。" +
            "高さを小さく詐称すると、下側の領域が表示されなくなる — そこにフラグが描かれている問題は頻出。"
          : "CRCはチャンク内容から機械的に決まる値。合わないということは、内容が後から書き換えられたか、CRCの更新を忘れたということ。",
        action: isIhdr ? "IHDRの幅・高さを復元する価値がある。元の寸法はCRCの総当たりで特定できる" : "改竄箇所として記録",
        command: isIhdr ? "# 高さを変えながらCRCが一致する値を総当たりする" : "pngcheck -v chal.png",
        outcome: "改竄の可能性が高い",
        confidence: 0.85,
        learn: "CRCは誤り検出用のチェックサムであって改竄防止ではない。だが『更新し忘れ』が手がかりとして残る。",
      });
    }

    // --- テキストチャンク（メタデータ） ---
    for (const c of chunks.filter((c) => c.type === "tEXt" || c.type === "iTXt" || c.type === "zTXt")) {
      const raw = b.subarray(c.dataStart, c.dataStart + c.length);
      let text = ascii(raw).replace(/\0/g, ": ");
      if (c.type === "zTXt") {
        const nul = raw.indexOf(0);
        const comp = raw.subarray(nul + 2);
        const out = await inflateZlib(comp);
        if (out) text = ascii(raw.subarray(0, nul)) + ": " + ascii(out);
      }
      const id = ctx.nextId();
      steps.push({
        id, analyzer: "png", genre: "forensics",
        title: `${c.type} メタデータを発見`,
        observation: text.slice(0, 300),
        reasoning: "テキストチャンクは作者やコメントを入れる場所。画像の見た目に一切影響しないため、ヒントやフラグの隠し場所として使われる。",
        action: "チャンク内容を復号・展開して読み出した",
        command: "exiftool chal.png",
        outcome: `${text.length} 文字のテキスト`,
        confidence: 0.7,
      });
      flags.push(...findFlags(new TextEncoder().encode(text), ctx.flagPatterns, `${c.type}チャンク`, ctx.node.path, id));
    }

    // --- 非標準チャンク ---
    const odd = chunks.filter((c) => !STANDARD.has(c.type));
    if (odd.length) {
      const id = ctx.nextId();
      steps.push({
        id, analyzer: "png", genre: "forensics",
        title: `規格外のチャンク型: ${odd.map((c) => c.type).join(", ")}`,
        observation: `PNG規格に定義されていない型が ${odd.length} 個ある`,
        reasoning: "デコーダは知らない補助チャンクを黙って読み飛ばす。この仕様を悪用して任意データを画像内に隠せる。",
        action: "各チャンクのデータ部を抽出した",
        command: "pngcheck -v chal.png",
        outcome: `${odd.length} 個を抽出`,
        confidence: 0.8,
      });
      for (const c of odd) {
        derived.push({ label: `${c.type}チャンクの中身`, bytes: b.subarray(c.dataStart, c.dataStart + c.length), fromStepId: id, recurse: true });
      }
    }

    return { steps, derived, flags };
  },
};
