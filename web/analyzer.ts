import type { ReportView } from "../src/core/view.ts";
// ?worker&inline で Worker のコードを本体に埋め込む。
// 単一HTMLとして配布する場合に別ファイルを参照できないため。
import AnalyzeWorker from "../src/ui/worker.ts?worker&inline";

/**
 * 解析Workerのクライアント。
 * 解析画面と教材画面の両方から使うので、Promiseで包んで1本化する。
 */
let worker: Worker | null = null;
let workerFailed = false;
let seq = 0;
const pending = new Map<number, { resolve: (v: ReportView) => void; reject: (e: Error) => void }>();

function getWorker(): Worker | null {
  if (worker || workerFailed) return worker;
  try {
    worker = new AnalyzeWorker();
    worker.onmessage = (e: MessageEvent) => {
      const { id, ok, view, error } = e.data;
      const p = pending.get(id);
      if (!p) return;
      pending.delete(id);
      ok ? p.resolve(view as ReportView) : p.reject(new Error(error));
    };
  } catch {
    // 配布形態によってはWorkerを起こせないことがある。
    // 解析できないよりは、UIが一瞬止まってもメインスレッドで走らせる方がよい。
    workerFailed = true;
  }
  return worker;
}

export function analyzeBytes(bytes: Uint8Array, name: string, format = ""): Promise<ReportView> {
  const w = getWorker();
  if (!w) return analyzeOnMainThread(bytes, name, format);

  const id = ++seq;
  // Workerへ渡した時点で元のバッファは使えなくなるため、複製を送る
  const buffer = bytes.slice().buffer;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    w.postMessage({ id, name, buffer, format }, [buffer]);
  });
}

/** Workerが使えない環境向けの代替経路 */
async function analyzeOnMainThread(bytes: Uint8Array, name: string, format: string): Promise<ReportView> {
  const [{ analyze }, { toView }, { userPattern, defaultPatterns }] = await Promise.all([
    import("../src/core/pipeline.ts"),
    import("../src/core/view.ts"),
    import("../src/core/flag.ts"),
  ]);
  const formatSpecified = !!format.trim();
  const report = await analyze(bytes, {
    label: name,
    flagPatterns: formatSpecified ? [userPattern(format.trim())] : defaultPatterns(),
    formatSpecified,
  });
  return toView(report);
}
