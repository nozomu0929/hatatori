/// <reference lib="webworker" />
import { analyze } from "../core/pipeline.ts";
import { toView } from "../core/view.ts";
import { userPattern, defaultPatterns } from "../core/flag.ts";

export interface AnalyzeRequest {
  id: number;
  name: string;
  buffer: ArrayBuffer;
  format?: string;
}

// 解析はCPUを数百ミリ秒〜数秒占有しうるのでWorkerで走らせる。
// メインスレッドで回すとドラッグ&ドロップ直後にUIが固まる。
self.onmessage = async (e: MessageEvent<AnalyzeRequest>) => {
  const { id, name, buffer, format } = e.data;
  try {
    const formatSpecified = !!format?.trim();
    const report = await analyze(new Uint8Array(buffer), {
      label: name,
      flagPatterns: formatSpecified ? [userPattern(format!.trim())] : defaultPatterns(),
      formatSpecified,
    });
    (self as unknown as Worker).postMessage({ id, ok: true, view: toView(report) });
  } catch (err) {
    (self as unknown as Worker).postMessage({ id, ok: false, error: String(err instanceof Error ? err.message : err) });
  }
};
