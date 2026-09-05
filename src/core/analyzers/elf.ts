import type { Analyzer, Ctx, AnalyzerResult, Derived, Step, FlagHit } from "../types.ts";
import { parseElf, isElf, sectionBytes, sectionTypeName, type ElfSection } from "../elf.ts";
import { entropy, ascii, hx } from "../bytes.ts";
import { findFlags } from "../flag.ts";

/**
 * ELF実行ファイルの静的解析。
 *
 * revの入口は逆アセンブルではなく「どこに何が置かれているか」の把握。
 * コードは.text、読み取り専用データは.rodata、と役割が決まっているので、
 * 探すべき場所は構造から絞れる。
 */
export const elf: Analyzer = {
  name: "elf",
  genre: "rev",
  applies: (ctx) => ctx.node.kind.id === "elf",
  run(ctx: Ctx): AnalyzerResult {
    const b = ctx.node.bytes;
    const steps: Step[] = [];
    const derived: Derived[] = [];
    const flags: FlagHit[] = [];

    const info = parseElf(b);
    if (!isElf(info)) {
      steps.push({
        id: ctx.nextId(), analyzer: "elf", genre: "rev",
        title: "ELFヘッダを読めなかった",
        observation: info.error,
        reasoning: "ヘッダが壊されている問題もある。その場合は既知の値を手で書き戻して復元する。",
        action: "構造解析を飛ばす",
        command: "readelf -h chal",
        outcome: "スキップ",
        confidence: 0.3,
      });
      return { steps, derived, flags };
    }

    // ── 1. 全体像 ──
    steps.push({
      id: ctx.nextId(), analyzer: "elf", genre: "rev",
      title: `${info.class}bit ${info.machine} の${info.type}`,
      observation:
        `エントリポイント ${hx(info.entry)}、セクション ${info.sections.length} 個、` +
        `${info.dynamic ? "動的リンク" : "静的リンク"}`,
      reasoning:
        "最初に確認するのはCPUの種類と実行形式。x86-64かARMかで使う道具が変わるし、" +
        "静的リンクなら必要なコードが全部このファイルに入っている＝解析対象は自己完結している、と分かる。" +
        "エントリポイントは実行が始まるアドレスで、逆アセンブルの出発点になる。",
      action: "ELFヘッダを読んだ",
      command: "readelf -h chal   /   file chal",
      outcome: `${info.machine} / ${info.type}`,
      confidence: 0.6,
      learn:
        "素性の分からないバイナリは実行しない。revの基本は『動かさずに読む』で、" +
        "どうしても動かす必要があるときは隔離環境を用意してから。",
    });

    // ── 2. セクション構成 ──
    const real = info.sections.filter((s) => s.name && s.size > 0);
    if (real.length) {
      steps.push({
        id: ctx.nextId(), analyzer: "elf", genre: "rev",
        title: `セクション構成を確認 — ${real.length} 個`,
        observation: real.map((s) => `${s.name}(${sectionTypeName(s.type)}, ${s.size}B${s.executable ? ", 実行可" : ""})`).join(" / "),
        reasoning:
          "ELFは役割ごとに領域が分かれている。.textは機械語、.rodataは書き換えない定数（文字列やテーブル）、" +
          ".dataは初期値付きの変数。『正解の文字列と比べる』処理があるなら、その比較対象は.rodataに置かれていることが多い。" +
          "つまり闇雲に全体を眺めるのではなく、.rodataから見ればよい。",
        action: "セクションヘッダ表を読み、各領域の役割と大きさを把握した",
        command: "readelf -S chal   /   objdump -h chal",
        outcome: `.text ${sizeOf(real, ".text")}、.rodata ${sizeOf(real, ".rodata")}`,
        confidence: 0.6,
      });
    }

    // ── 3. .rodata を独立したデータとして掘る ──
    for (const s of real.filter((x) => x.name === ".rodata" || x.name === ".data")) {
      const data = sectionBytes(b, s);
      if (!data.length) continue;
      const id = ctx.nextId();
      const h = entropy(data);
      const hits = findFlags(data, ctx.flagPatterns, `${s.name}セクション`, ctx.node.path, id);
      flags.push(...hits);
      steps.push({
        id, analyzer: "elf", genre: "rev",
        title: `${s.name} を取り出した（${data.length} バイト、エントロピー ${h.toFixed(2)}）`,
        observation: hits.length
          ? `${hits[0].value} を含んでいた`
          : `平文のフラグは無い。先頭: ${JSON.stringify(ascii(data, 0, Math.min(60, data.length)).replace(/[^\x20-\x7e]/g, "."))}`,
        reasoning:
          hits.length
            ? "定数領域にフラグがそのまま置かれていた。文字列比較で正誤を判定するプログラムでは、比較対象がここに残る。"
            : "平文で無いなら、符号化されているか、実行時に組み立てられている。" +
              "定数領域だけを切り出して別途調べれば、ファイル全体を相手にするより手数が減る。",
        action: `${s.name} を独立したデータとして切り出し、再帰的に解析する`,
        command: `objcopy -O binary --only-section=${s.name} chal ${s.name.slice(1)}.bin`,
        outcome: hits.length ? "フラグに到達" : `${data.length} バイトを抽出`,
        confidence: hits.length ? 0.9 : 0.5,
      });
      if (!hits.length) derived.push({ label: `${s.name}セクション`, bytes: data, fromStepId: id, recurse: true });
    }

    // ── 4. コード中で1バイトずつ組み立てられる文字列 ──
    for (const s of real.filter((x) => x.executable)) {
      const code = sectionBytes(b, s);
      for (const run of findStackStrings(code)) {
        const id = ctx.nextId();
        const hits = findFlags(run.text, ctx.flagPatterns, `${s.name}内の即値列`, ctx.node.path, id);
        flags.push(...hits);
        steps.push({
          id, analyzer: "elf", genre: "rev",
          title: `コード中に1バイトずつ書かれた文字列（${run.text.length} 文字）`,
          observation: `${s.name} の ${hx(s.offset + run.offset)} 付近に、` +
            `mov byte [${run.base}], 即値 という命令が ${run.count} 個連続している。` +
            `即値を並べると: ${JSON.stringify(new TextDecoder().decode(run.text))}`,
          reasoning:
            "文字列をデータ領域に置かず、コードの中で1バイトずつスタックに書き込む手法。" +
            "データとして連続して存在しないので strings には出てこない。" +
            "「stringsで何も出ない＝隠されている」ではなく「stringsでは見えない置き方をされている」だけのことが多い。",
          action: "連続する即値を命令列から拾い、書き込み先の位置順に並べ直した",
          command: "objdump -d chal | grep 'movb'",
          outcome: hits.length ? "フラグに到達" : "文字列を復元",
          confidence: hits.length ? 0.95 : 0.6,
          learn:
            "コンパイラも最適化で同じことをするので、この形自体は珍しくない。" +
            "意図的な難読化と区別がつかないことも多く、どちらにせよ命令から読み取るしかない。",
        });
      }
    }

    return { steps, derived, flags };
  },
};

function sizeOf(sections: ElfSection[], name: string): string {
  const s = sections.find((x) => x.name === name);
  return s ? `${s.size}B` : "なし";
}

interface StackString { offset: number; text: Uint8Array; count: number; base: string; }

/**
 * mov byte [rbp+disp8], imm8 / mov byte [rsp+disp8], imm8 の連続を探す。
 * 書き込み先の変位でソートしてから連結する — 命令の順序と
 * メモリ上の並びは必ずしも一致しないため。
 */
function findStackStrings(code: Uint8Array, minLen = 6): StackString[] {
  const out: StackString[] = [];
  let i = 0;
  while (i < code.length) {
    const pairs: { disp: number; val: number }[] = [];
    const start = i;
    let base = "";
    while (i < code.length) {
      if (code[i] === 0xc6 && code[i + 1] === 0x45 && i + 3 < code.length) {
        pairs.push({ disp: toSigned(code[i + 2]), val: code[i + 3] });
        base = base || "rbp+disp";
        i += 4;
      } else if (code[i] === 0xc6 && code[i + 1] === 0x44 && code[i + 2] === 0x24 && i + 4 < code.length) {
        pairs.push({ disp: toSigned(code[i + 3]), val: code[i + 4] });
        base = base || "rsp+disp";
        i += 5;
      } else break;
    }
    if (pairs.length >= minLen) {
      pairs.sort((a, b) => a.disp - b.disp);
      out.push({
        offset: start,
        text: new Uint8Array(pairs.map((p) => p.val)),
        count: pairs.length,
        base,
      });
    }
    if (i === start) i++;
    if (out.length >= 8) break;
  }
  return out;
}

const toSigned = (v: number) => (v > 127 ? v - 256 : v);
