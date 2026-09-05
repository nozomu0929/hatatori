import type { ReportView } from "../src/core/view.ts";
import type { FlagHit } from "../src/core/types.ts";
import { el, $, fmtSize } from "./dom.ts";
import { analyzeBytes } from "./analyzer.ts";
import { renderFull, renderHints, renderTree, flagRow } from "./render.ts";

let current: ReportView | null = null;
let currentName = "";
let mode: "hint" | "full" | "tree" = "hint";
let hintsShown = 1;
// 一度開いた答えはモード切替で伏せ直さない。隠す目的は
// 「答えから入らせないこと」であって、見た人に隠し続けることではない。
let answerRevealed = false;

export function initAnalyzeView(): void {
  const drop = $<HTMLElement>("drop");
  const fileInput = $<HTMLInputElement>("file");

  drop.addEventListener("click", () => fileInput.click());
  drop.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fileInput.click(); }
  });
  fileInput.addEventListener("change", () => {
    const f = fileInput.files?.[0];
    if (f) void run(f);
  });

  // ドラッグ&ドロップはデスクトップ専用の操作。
  // モバイルではタップでのファイル選択が主経路になる。
  for (const ev of ["dragenter", "dragover"]) {
    drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("over"); });
  }
  for (const ev of ["dragleave", "drop"]) {
    drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("over"); });
  }
  drop.addEventListener("drop", (e) => {
    const f = (e as DragEvent).dataTransfer?.files?.[0];
    if (f) void run(f);
  });
  // ウィンドウのどこに落としてもブラウザが勝手にファイルを開かないようにする
  window.addEventListener("dragover", (e) => e.preventDefault());
  window.addEventListener("drop", (e) => e.preventDefault());

  document.querySelectorAll<HTMLButtonElement>("#analyze .modes button").forEach((b) => {
    b.addEventListener("click", () => {
      document.querySelectorAll("#analyze .modes button").forEach((x) => x.classList.remove("on"));
      b.classList.add("on");
      mode = b.dataset.mode as typeof mode;
      render();
    });
  });
}

async function run(file: File) {
  const statusEl = $<HTMLElement>("status");
  const resultEl = $<HTMLElement>("result");
  currentName = file.name;
  resultEl.hidden = true;
  statusEl.hidden = false;
  statusEl.className = "status";
  statusEl.textContent = `${file.name}（${fmtSize(file.size)}）を解析中…`;

  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const format = $<HTMLInputElement>("format").value;
    current = await analyzeBytes(bytes, file.name, format);
  } catch (e) {
    statusEl.className = "status err";
    statusEl.textContent = `解析に失敗しました: ${e instanceof Error ? e.message : e}`;
    return;
  }

  hintsShown = 1;
  answerRevealed = false;
  statusEl.hidden = true;
  resultEl.hidden = false;
  $<HTMLElement>("fname").textContent = currentName;
  $<HTMLElement>("fmeta").textContent =
    `${current.tree.kind} / ${fmtSize(current.tree.size)} / 手順${current.walkthrough.length}件 / ${current.elapsedMs}ms`;
  render();
  // 解析が終わったら結果まで運ぶ。手動スクロールを強いない
  resultEl.scrollIntoView({ behavior: "smooth", block: "start" });
}

function render() {
  if (!current) return;
  renderAnswer(current.flags);
  $<HTMLElement>("body").replaceChildren(
    mode === "hint" ? renderHints(current.keySteps, hintsShown, () => { hintsShown++; render(); })
    : mode === "full" ? renderFull(current.walkthrough)
    : renderTree(current.tree),
  );
}

/** 答えは常に伏せる。目的は答えを得ることではなく解けるようになること */
function renderAnswer(flags: FlagHit[]) {
  const answerEl = $<HTMLElement>("answer");
  answerEl.replaceChildren();
  if (!flags.length) {
    answerEl.append(el("div", "status", "フラグ候補は見つかりませんでした。未対応の手法かもしれません。"));
    return;
  }

  // 有力候補が出ているなら、低確度のものは既定で畳む。
  // 例えばROT13問題では暗号文そのもの(synt{...})も xxx{...} の形をしているため
  // 候補には挙がるが、答えとして並べるとかえって迷わせる。
  const strong = flags.filter((f) => f.confidence >= 0.85);
  const shown = strong.length ? strong : flags;
  const rest = flags.length - shown.length;

  const reveal = () => {
    answerRevealed = true;
    const rows: HTMLElement[] = shown.map(flagRow);
    if (rest > 0) {
      const more = el("button", "reveal", `確度の低い候補も見る（${rest} 件）`);
      more.addEventListener("click", () => answerEl.replaceChildren(...flags.map(flagRow)));
      rows.push(more);
    }
    answerEl.replaceChildren(...rows);
  };

  if (answerRevealed) return reveal();

  const btn = el("button", "reveal", strong.length
    ? `答えを見る（有力候補 ${strong.length} 件）`
    : `答えを見る（候補 ${flags.length} 件・いずれも確度低）`);
  btn.addEventListener("click", reveal);
  answerEl.append(btn);
}
