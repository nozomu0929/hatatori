import type { Analyzer, Ctx, AnalyzerResult, Derived, Step, FlagHit } from "../types.ts";
import { decodePng, isImage } from "../png-decode.ts";
import { encodeRgbPng, toDataUrl } from "../png-encode.ts";
import { findFlags } from "../flag.ts";
import { printableRatio, extractStrings } from "../bytes.ts";

/**
 * 最下位ビット(LSB)ステガノグラフィの検出。
 *
 * 画素値を1だけ変えても人間の目には区別がつかない。
 * この「見えない余白」にデータを詰めるのがLSB法で、画像ステガノの最頻出手法。
 * 隠す側の選択肢（どのチャンネルを使うか・ビットの並び順）は限られているので、
 * 総当たりが成立する。zsteg がやっているのも本質的にこれ。
 */

type ChannelSet = { id: string; label: string; idx: number[] };

const CHANNELS: ChannelSet[] = [
  { id: "rgb", label: "R,G,Bを順に", idx: [0, 1, 2] },
  { id: "b",   label: "Bのみ",        idx: [2] },
  { id: "g",   label: "Gのみ",        idx: [1] },
  { id: "r",   label: "Rのみ",        idx: [0] },
  { id: "bgr", label: "B,G,Rの順に",  idx: [2, 1, 0] },
  { id: "a",   label: "アルファのみ", idx: [3] },
];

export const lsb: Analyzer = {
  name: "lsb",
  genre: "stego",
  applies: (ctx) => ctx.node.kind.id === "png" && ctx.node.bytes.length > 100,
  async run(ctx: Ctx): Promise<AnalyzerResult> {
    const steps: Step[] = [];
    const derived: Derived[] = [];
    const flags: FlagHit[] = [];

    const img = await decodePng(ctx.node.bytes);
    if (!isImage(img)) {
      steps.push({
        id: ctx.nextId(), analyzer: "lsb", genre: "stego",
        title: "画素を取り出せなかった",
        observation: img.error,
        reasoning: "ステガノ解析には絵そのものが要る。展開できない場合は、破損か未対応の形式。破損自体が問題の仕掛けであることもある。",
        action: "LSB解析を飛ばす",
        command: "pngcheck -v chal.png",
        outcome: "スキップ",
        confidence: 0.2,
      });
      return { steps, derived, flags };
    }

    const { width, height, pixels } = img;
    const total = width * height;
    if (total > 4_000_000) return { steps, derived, flags }; // 大きすぎる画像は総当たりしない

    // ── 1. 最下位ビット面が他のビット面と食い違っていないかを測る ──
    //
    // 当初は「最下位ビット面がランダムでなければ怪しい」としていたが、これは誤りだった。
    // アイコンやCG、平坦な領域を持つ画像では、隠し事が無くても最下位ビット面は
    // 全面的に規則的になる（実測で一致率97%）。絶対値では判定できない。
    //
    // 正しくは、最下位ビット面を「1つ上のビット面」と比べる。
    // 手を加えていない画像なら、どのビット面も同じ絵の構造を反映するので
    // 一致率はほぼ揃う。最下位ビットにだけ何かを書き込むと、
    // そこだけが他の面と食い違う。この「面の間のズレ」が埋め込みの痕跡になる。
    const agree0 = planeAgreement(pixels, width, height, 0);
    const agree1 = planeAgreement(pixels, width, height, 1);
    const gap = Math.abs(agree0 - agree1);
    const suspicious = gap > 0.10;
    const planeId = ctx.nextId();
    steps.push({
      id: planeId, analyzer: "lsb", genre: "stego",
      title: suspicious
        ? `最下位ビット面だけが他と食い違っている（差 ${(gap * 100).toFixed(1)}ポイント）`
        : `ビット面どうしに目立った食い違いなし（差 ${(gap * 100).toFixed(1)}ポイント）`,
      observation:
        `${width}×${height} の画素について、隣り合う画素でビットが一致する割合を面ごとに測った。` +
        `最下位ビット面 ${(agree0 * 100).toFixed(1)}%、1つ上の面 ${(agree1 * 100).toFixed(1)}%`,
      reasoning:
        "手を加えていない画像では、どのビット面も同じ絵の構造を反映するので、一致率はビット面をまたいでほぼ揃う。" +
        "最下位ビットにだけ何かを書き込むと、その面だけが他と食い違う。" +
        "『最下位ビット面が規則的かどうか』を単体で見ても判定できない — " +
        "アイコンやCGのように平坦な部分が多い画像では、隠し事が無くても規則的になるため。比較して初めて意味が出る。",
      action: "最下位ビット面を白黒画像として書き出す",
      command: "zsteg -a chal.png   /   stegsolve でビットプレーンを1枚ずつ見る",
      outcome: suspicious ? "この面にだけ人工的な情報がある。画像として目で見る価値が高い" : "統計的には特に異常なし（少量の埋め込みはこの指標では出ない）",
      confidence: suspicious ? 0.85 : 0.3,
      learn:
        "画素値を1変えても見た目は変わらないが、その1ビットだけを集めて白黒画像にすると、隠された絵や文字がそのまま浮かび上がる。" +
        "なお、大きな画像に数十バイトだけ埋めた場合はこの統計に出てこない。統計で出ないことは「隠されていない」ことを意味しないので、面は必ず目でも確認する。",
      attachments: [{
        label: "最下位ビット面（白黒）",
        pngDataUrl: toDataUrl(await bitPlanePng(pixels, width, height)),
      }],
    });

    // ── 2. 埋め込まれたバイト列を総当たりで取り出す ──
    for (const ch of CHANNELS) {
      for (const msbFirst of [true, false]) {
        const bytes = extractBits(pixels, total, ch.idx, msbFirst);
        const hits = findFlags(bytes, ctx.flagPatterns, `LSB(${ch.id}, ${msbFirst ? "MSB先頭" : "LSB先頭"})`, ctx.node.path, "");
        const strong = hits.filter((h) => ctx.formatSpecified || h.confidence >= 0.85);
        const readable = leadingPrintable(bytes);

        if (!strong.length && readable < 12) continue;

        const id = ctx.nextId();
        for (const h of strong) h.viaStepId = id;
        flags.push(...strong);
        steps.push({
          id, analyzer: "lsb", genre: "stego",
          title: `LSBからデータを抽出（${ch.label}／${msbFirst ? "MSB先頭" : "LSB先頭"}）`,
          observation: strong.length
            ? `${strong[0].value} が現れた`
            : `先頭から ${readable} バイトが読める文字列になった: ${JSON.stringify(new TextDecoder().decode(bytes.subarray(0, Math.min(readable, 60))))}`,
          reasoning:
            "各画素の最下位ビットを順に集めて8個ずつ束ねるとバイト列になる。" +
            "どのチャンネルを何番目から使うか、ビットをどちら向きに詰めるかは埋めた側の選択で、" +
            "組み合わせは十数通りしかない。だから全部試せばよい。",
          action: `${ch.label}の最下位ビットを${msbFirst ? "上位ビットから" : "下位ビットから"}詰めてバイト列に戻した`,
          command: `zsteg -E 'b1,${ch.id},${msbFirst ? "msb" : "lsb"}' chal.png`,
          outcome: strong.length ? "フラグに到達" : "読めるデータを取り出した",
          confidence: strong.length ? 0.95 : 0.65,
          learn:
            "組み合わせの数が現実的なら総当たりでよい、という発想はシーザー暗号やXORと同じ。" +
            "ステガノでも「隠す側の選択肢を数える」ところから始める。",
        });

        // フラグが出ていなければ、取り出したデータ自体を次の解析対象にする
        if (!strong.length) {
          derived.push({ label: `LSB抽出(${ch.id})`, bytes: trimTrailing(bytes), fromStepId: id, recurse: true });
        }
        break; // 同じチャンネルで両方の並び順を報告しても情報が増えない
      }
    }

    return { steps, derived, flags };
  },
};

/** 指定チャンネルの最下位ビットを集めてバイト列に戻す */
function extractBits(pixels: Uint8Array, total: number, channels: number[], msbFirst: boolean): Uint8Array {
  const bitCount = total * channels.length;
  const out = new Uint8Array(Math.floor(bitCount / 8));
  let bit = 0;
  for (let i = 0; i < total; i++) {
    const base = i * 4;
    for (const c of channels) {
      const v = pixels[base + c] & 1;
      const byteIdx = bit >> 3;
      if (byteIdx >= out.length) return out;
      out[byteIdx] |= v << (msbFirst ? 7 - (bit & 7) : bit & 7);
      bit++;
    }
  }
  return out;
}

/** 先頭から何バイト連続で印字可能文字が続くか */
function leadingPrintable(b: Uint8Array): number {
  let n = 0;
  for (; n < b.length && n < 4096; n++) {
    const c = b[n];
    if (!((c >= 0x20 && c <= 0x7e) || c === 0x0a || c === 0x0d)) break;
  }
  return n;
}

/** 末尾の無意味な0埋めを落とす */
function trimTrailing(b: Uint8Array): Uint8Array {
  let end = b.length;
  while (end > 0 && b[end - 1] === 0) end--;
  return b.subarray(0, Math.max(end, 1));
}

/**
 * 指定ビット面について「横に隣り合う画素でビットが一致する割合」を返す。
 * 面どうしを比較するために使う。単独の値には意味が無い。
 */
function planeAgreement(pixels: Uint8Array, width: number, height: number, bit: number): number {
  let same = 0, n = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 1; x < width; x++) {
      const a = (pixels[(y * width + x) * 4] >> bit) & 1;
      const b = (pixels[(y * width + x - 1) * 4] >> bit) & 1;
      if (a === b) same++;
      n++;
    }
  }
  return n ? same / n : 0;
}

/** 最下位ビット面を白黒PNGにする。目で見れば一発で分かるものが多い */
async function bitPlanePng(pixels: Uint8Array, width: number, height: number): Promise<Uint8Array> {
  const rgb = new Uint8Array(width * height * 3);
  for (let i = 0, n = width * height; i < n; i++) {
    const v = (pixels[i * 4] & 1) ? 255 : 0;
    rgb[i * 3] = rgb[i * 3 + 1] = rgb[i * 3 + 2] = v;
  }
  return encodeRgbPng(width, height, rgb);
}

export { extractBits, planeAgreement, printableRatio, extractStrings };
