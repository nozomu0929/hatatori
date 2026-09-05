import type { Analyzer, ArtifactNode, Ctx, Report, Step, FlagHit, Derived } from "./types.ts";
import { detectKind } from "./magic.ts";
import { defaultPatterns } from "./flag.ts";
import { recon } from "./analyzers/recon.ts";
import { flagscan } from "./analyzers/flagscan.ts";
import { png } from "./analyzers/png.ts";
import { zip } from "./analyzers/zip.ts";
import { embedded } from "./analyzers/embedded.ts";
import { encoding } from "./analyzers/encoding.ts";
import { lsb } from "./analyzers/lsb.ts";
import { elf } from "./analyzers/elf.ts";
import { exif } from "./analyzers/exif.ts";

/**
 * 実行順は解説の読み順にそのままなる。
 * 「まず何者か → 素直に探す → 構造を読む → 埋め込みを剥がす → 変換を疑う」
 * という、人間が実際に辿る思考順に固定している。
 */
export const ANALYZERS: Analyzer[] = [recon, flagscan, png, exif, zip, elf, embedded, lsb, encoding];

export interface AnalyzeOptions {
  label?: string;
  flagPatterns?: RegExp[];
  maxDepth?: number;
  /** これより小さい派生データは追わない */
  minChildSize?: number;
  /** flagPatterns がユーザー指定由来なら true */
  formatSpecified?: boolean;
}

export async function analyze(bytes: Uint8Array, opts: AnalyzeOptions = {}): Promise<Report> {
  const t0 = Date.now();
  let counter = 0;
  const nextId = () => `s${++counter}`;
  const flags: FlagHit[] = [];
  const walkthrough: Step[] = [];

  const root = makeNode(bytes, opts.label ?? "input", []);
  await visit(root, 0);

  return { root, flags: rankFlags(flags), walkthrough, elapsedMs: Date.now() - t0 };

  async function visit(node: ArtifactNode, depth: number) {
    const claimed: { start: number; end: number; by: string }[] = [];
    const ctx: Ctx = {
      node,
      flagPatterns: opts.flagPatterns ?? defaultPatterns(),
      formatSpecified: opts.formatSpecified ?? false,
      depth,
      maxDepth: opts.maxDepth ?? 4,
      nextId,
      claim: (start, end, by) => { claimed.push({ start, end, by }); },
      isClaimed: (offset) => claimed.find((c) => offset >= c.start && offset < c.end)?.by ?? null,
    };
    const pending: Derived[] = [];

    for (const a of ANALYZERS) {
      if (!a.applies(ctx)) continue;
      let r;
      try {
        r = await a.run(ctx);
      } catch (e) {
        // 1つのアナライザの失敗で全体を止めない
        node.steps.push({
          id: nextId(), analyzer: a.name, genre: a.genre,
          title: `${a.name} の解析中にエラー`,
          observation: String(e instanceof Error ? e.message : e),
          reasoning: "壊れたファイルや想定外の構造では解析器が落ちることがある。それ自体が『細工されている』手がかりでもある。",
          action: "このアナライザを飛ばして続行",
          outcome: "スキップ",
          confidence: 0.2,
        });
        continue;
      }
      node.steps.push(...r.steps);
      walkthrough.push(...r.steps);
      flags.push(...r.flags);
      pending.push(...r.derived);
    }

    if (depth >= (opts.maxDepth ?? 4)) return;
    const minSize = opts.minChildSize ?? 8;
    const seen = new Set<string>();
    for (const d of pending) {
      if (!d.recurse || d.bytes.length < minSize) continue;
      const key = fingerprint(d.bytes);
      if (seen.has(key)) continue; // 別アナライザが同じ塊を抽出した場合の重複を排除
      seen.add(key);
      const child = makeNode(d.bytes, d.label, [...node.path, d.label]);
      node.children.push(child);
      await visit(child, depth + 1);
    }
  }
}

function makeNode(bytes: Uint8Array, label: string, parentPath: string[]): ArtifactNode {
  return {
    path: parentPath.length ? parentPath : [label],
    label,
    bytes,
    kind: detectKind(bytes),
    steps: [],
    children: [],
  };
}

function fingerprint(b: Uint8Array): string {
  const head = Array.from(b.subarray(0, 16)).map((v) => v.toString(16)).join("");
  return `${b.length}:${head}`;
}

function rankFlags(flags: FlagHit[]): FlagHit[] {
  const best = new Map<string, FlagHit>();
  for (const f of flags) {
    const prev = best.get(f.value);
    if (!prev || f.confidence > prev.confidence) best.set(f.value, f);
  }
  return [...best.values()].sort((a, b) => b.confidence - a.confidence);
}
