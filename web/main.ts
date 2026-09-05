import { $ } from "./dom.ts";
import { initAnalyzeView } from "./analyze-view.ts";
import { initLearnView } from "./learn-view.ts";

// ── 画面切替 ──
type Tab = "learn" | "analyze";
function show(tab: Tab) {
  for (const t of ["learn", "analyze"] as Tab[]) {
    $<HTMLElement>(t).hidden = t !== tab;
  }
  document.querySelectorAll<HTMLButtonElement>(".tabs button").forEach((b) => {
    b.classList.toggle("on", b.dataset.tab === tab);
  });
  location.hash = tab;
  window.scrollTo({ top: 0 });
}

document.querySelectorAll<HTMLButtonElement>(".tabs button").forEach((b) => {
  b.addEventListener("click", () => show(b.dataset.tab as Tab));
});

initAnalyzeView();
initLearnView();
// 学習を既定にする。このアプリの目的は解析結果を得ることではなく、解けるようになること
show(location.hash === "#analyze" ? "analyze" : "learn");

if ("serviceWorker" in navigator && location.protocol !== "http:") {
  navigator.serviceWorker.register("./sw.js").catch(() => {});
}
