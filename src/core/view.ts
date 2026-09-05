import type { Report, ArtifactNode, Step, FlagHit } from "./types.ts";

/**
 * Workerからメインスレッドへ渡すための表示用データ。
 * ArtifactNode は解析対象のバイト列そのものを抱えているため、
 * そのまま postMessage するとファイル全体を丸ごと複製することになる。
 * 表示に必要なメタ情報だけを抜き出す。
 */
export interface NodeView {
  label: string;
  kind: string;
  size: number;
  children: NodeView[];
}

export interface ReportView {
  flags: FlagHit[];
  walkthrough: Step[];
  tree: NodeView;
  elapsedMs: number;
  /** 手がかりとして意味のある手順のみ（ヒントモード用） */
  keySteps: Step[];
}

export function toView(r: Report): ReportView {
  return {
    flags: r.flags,
    walkthrough: r.walkthrough,
    tree: nodeView(r.root),
    elapsedMs: r.elapsedMs,
    keySteps: dedupe(r.walkthrough.filter((s) => s.confidence >= 0.6)),
  };
}

function nodeView(n: ArtifactNode): NodeView {
  return { label: n.label, kind: n.kind.label, size: n.bytes.length, children: n.children.map(nodeView) };
}

/**
 * 同じ手を繰り返し提示しない。
 * 再帰解析では「ファイル種別の特定」のような手順が階層ごとに出てくるが、
 * ヒントとしては1回示せば足りる。
 */
function dedupe(steps: Step[]): Step[] {
  const seen = new Set<string>();
  const out: Step[] = [];
  for (const s of steps) {
    const key = `${s.analyzer}:${s.title.replace(/\d+/g, "N")}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}
