import type { Analyzer, Ctx, AnalyzerResult } from "../types.ts";
import { findFlags } from "../flag.ts";

/** 生バイト列に対する直接検索。最も素朴で、意外に当たる */
export const flagscan: Analyzer = {
  name: "flagscan",
  genre: "recon",
  applies: () => true,
  run(ctx: Ctx): AnalyzerResult {
    const id = ctx.nextId();
    const hits = findFlags(ctx.node.bytes, ctx.flagPatterns, "ファイル内の平文", ctx.node.path, id);
    const step = {
      id, analyzer: "flagscan", genre: "recon" as const,
      title: hits.length ? `平文のフラグ書式に ${hits.length} 件ヒット` : "平文にフラグ書式は見当たらず",
      observation: hits.length
        ? hits.slice(0, 5).map((h) => `${h.value}（確度 ${(h.confidence * 100) | 0}%）`).join(" / ")
        : "xxx{...} 形式の文字列はそのままの形では存在しない",
      reasoning:
        "まず加工なしで探す。手間をかける前に一番安い手を試すのが鉄則で、" +
        "見つからなかった場合も『少なくとも平文ではない』という次の一手の根拠になる。",
      action: "ファイル全体を1つの文字列とみなし、フラグ書式の正規表現を適用した",
      command: "grep -aoE '[A-Za-z0-9_]+\\{[^}]+\\}' chal.bin",
      outcome: hits.length ? "候補あり（下記フラグ一覧に集約）" : "ヒットなし。エンコード・埋め込み・ステガノを疑う段階へ",
      confidence: hits.length ? 0.8 : 0.3,
      learn: "grep の -a はバイナリファイルもテキストとして扱うオプション。これを忘れて『何も出ない』と誤解するのは初心者の典型。",
    };
    return { steps: [step], derived: [], flags: hits };
  },
};
