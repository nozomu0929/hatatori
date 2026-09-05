import type { Analyzer, Ctx, AnalyzerResult, Derived, Step, FlagHit } from "../types.ts";
import { printableRatio, ascii, hx } from "../bytes.ts";
import { findFlags } from "../flag.ts";
import { base64Decode, base32Decode, hexDecode, rot, findEncodedRuns, type Candidate } from "../codecs.ts";

/**
 * エンコーディング総当たり。
 * 「意味を保ったまま見た目を変える」だけの変換は、考えるより全部試す方が速い。
 */
export const encoding: Analyzer = {
  name: "encoding",
  genre: "crypto",
  applies: (ctx) => ctx.node.bytes.length > 8 && ctx.node.bytes.length < 8 * 1024 * 1024,
  run(ctx: Ctx): AnalyzerResult {
    const b = ctx.node.bytes;
    const steps: Step[] = [];
    const derived: Derived[] = [];
    const flags: FlagHit[] = [];
    const whole = ascii(b.subarray(0, Math.min(b.length, 1_000_000)));

    // --- 1. 符号化された断片のデコード ---
    for (const c of findEncodedRuns(whole, 12)) {
      const out = decodeOne(c);
      if (!out || !looksMeaningful(out)) continue;
      const id = ctx.nextId();
      const text = ascii(out);
      const hits = findFlags(out, ctx.flagPatterns, `${c.kind}デコード結果`, ctx.node.path, id);
      steps.push({
        id, analyzer: "encoding", genre: "crypto",
        title: `${c.kind}としてデコード成功`,
        observation: `入力: ${trunc(c.text, 60)}\n出力: ${trunc(text, 120)}`,
        reasoning:
          `オフセット${hx(c.offset)}に${c.kind}の文字種だけで構成された長さ${c.text.length}の連続領域があった。` +
          "デコード結果が印字可能な文字列になったので、偶然の一致ではなく実際にその形式で符号化されていたと判断できる。",
        action: `${c.kind}デコードを適用`,
        command: c.kind === "Base64" ? `echo '${trunc(c.text, 30)}' | base64 -d`
               : c.kind === "Base32" ? `echo '${trunc(c.text, 30)}' | base32 -d`
               : `echo '${trunc(c.text, 30)}' | xxd -r -p`,
        outcome: hits.length ? "フラグを含む文字列を得た" : `${out.length} バイトの平文を得た`,
        confidence: hits.length ? 0.95 : 0.6,
        learn:
          "Base64はA-Za-z0-9+/と末尾の=、Base32は大文字A-Zと数字2-7だけで構成される。" +
          "この『使われている文字の種類』を見るだけで、どの符号かはほぼ判別できる。デコード結果がまた符号化されていること(多重エンコード)も多い。",
      });
      flags.push(...hits);
      // フラグが出なければ、その平文をさらに解析対象として掘り下げる
      if (!hits.length) derived.push({ label: `${c.kind}デコード結果`, bytes: out, fromStepId: id, recurse: true });
    }

    // --- 2. ROT-n 総当たり ---
    for (let n = 1; n < 26; n++) {
      const hits = accept(ctx, findFlags(new TextEncoder().encode(rot(whole, n)), ctx.flagPatterns, `ROT${n}`, ctx.node.path, ""));
      if (!hits.length) continue;
      const id = ctx.nextId();
      for (const h of hits) h.viaStepId = id;
      steps.push({
        id, analyzer: "encoding", genre: "crypto",
        title: `ROT${n}（シーザー暗号、ずらし幅${n}）で平文化`,
        observation: `全アルファベットを${n}文字ずらすと ${hits[0].value} が出現`,
        reasoning:
          "アルファベットを一定数ずらすだけの古典暗号。鍵の候補が25通りしかないため、総当たりが常に成立する。" +
          "ROT13は13ずらすと元に戻る（自分自身が逆変換になる）性質から特に多用される。",
        action: "ずらし幅1〜25を全て試し、既知のフラグ書式が現れる幅を探した",
        command: `tr 'A-Za-z' '${rotAlphaSpec(n)}' < chal.txt`,
        outcome: `幅${n}で成功`,
        confidence: 0.9,
        learn: "鍵空間が小さい暗号は『解読』ではなく『全列挙』で落ちる。頭を使う前に、鍵が何通りあるかを数えるのが先。",
      });
      flags.push(...hits);
      break;
    }

    // --- 3. 単一バイトXOR 総当たり ---
    const window = b.subarray(0, Math.min(b.length, 1_000_000));
    for (let k = 1; k < 256; k++) {
      const x = new Uint8Array(window.length);
      for (let i = 0; i < x.length; i++) x[i] = window[i] ^ k;
      const hits = accept(ctx, findFlags(x, ctx.flagPatterns, `XOR ${hx(k)}`, ctx.node.path, ""));
      if (!hits.length) continue;
      const id = ctx.nextId();
      for (const h of hits) h.viaStepId = id;
      steps.push({
        id, analyzer: "encoding", genre: "crypto",
        title: `単一バイトXOR（鍵 ${hx(k)}）で平文化`,
        observation: `全バイトを ${hx(k)} とXORすると ${hits[0].value} が出現`,
        reasoning:
          "XORは同じ鍵をもう一度かければ元に戻る対称な演算。鍵が1バイトなら候補は255通りしかなく、総当たりで必ず解ける。",
        action: "鍵0x01〜0xFFを全て試し、既知のフラグ書式が現れる鍵を探した",
        command: `xortool-xor -f chal.bin -h ${k.toString(16)}`,
        outcome: `鍵 ${hx(k)} で成功`,
        confidence: 0.92,
        learn:
          "鍵が長い場合も、まず頻度分析(xortool)で鍵長を推定し、1バイトずつに分解して同じ総当たりに持ち込む。" +
          "XORは『同じ鍵を使い回すと弱い』暗号の代表例。",
      });
      flags.push(...hits);
      break;
    }

    if (steps.length === 0) {
      steps.push({
        id: ctx.nextId(), analyzer: "encoding", genre: "crypto",
        title: "既知のエンコーディングには該当せず",
        observation: "Base64/Base32/16進/ROT-n/単一バイトXOR のいずれでもフラグは現れなかった",
        reasoning: "安価な変換を全て潰しておくと、残る可能性(本格的な暗号、ステガノグラフィ、別形式の埋め込み)に絞り込める。除外もまた前進。",
        action: "全パターンを試行して除外した",
        command: "# CyberChef の Magic 機能が同等の総当たりを行う",
        outcome: "該当なし",
        confidence: 0.25,
      });
    }
    return { steps, derived, flags };
  },
};

/**
 * 総当たり結果の採否。
 * 汎用パターン xxx{...} は乱数バイト列にも普通に当たるため、
 * 255通り×26通りを試す文脈では「既知のフラグ接頭辞であること」を要求する。
 * ユーザーが書式を明示している場合はパターン自体が十分に厳しいので、そのまま信用する。
 */
function accept(ctx: Ctx, hits: FlagHit[]): FlagHit[] {
  return hits.filter((h) => ctx.formatSpecified || h.confidence >= 0.85);
}

function decodeOne(c: Candidate): Uint8Array | null {
  return c.kind === "Base64" ? base64Decode(c.text)
       : c.kind === "Base32" ? base32Decode(c.text)
       : hexDecode(c.text);
}
function looksMeaningful(b: Uint8Array): boolean {
  if (b.length < 4) return false;
  return printableRatio(b) > 0.85 || b.length > 32;
}
function trunc(s: string, n: number): string {
  const t = s.replace(/[\r\n]+/g, " ");
  return t.length > n ? t.slice(0, n) + "…" : t;
}
function rotAlphaSpec(n: number): string {
  const up = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const lo = "abcdefghijklmnopqrstuvwxyz";
  return up.slice(n) + up.slice(0, n) + lo.slice(n) + lo.slice(0, n);
}
