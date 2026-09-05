import type { Step, FlagHit } from "../src/core/types.ts";
import type { NodeView } from "../src/core/view.ts";
import { el, defs, fmtSize } from "./dom.ts";

/** 手順カード（全解説モード）。観察→根拠→操作→手動→結果→補足 */
export function stepCard(s: Step, index: number): HTMLElement {
  const c = el("div", "step");
  c.dataset.genre = s.genre;

  const h = el("h3");
  h.append(el("span", "num", `[${index + 1}]`), document.createTextNode(s.title),
           el("span", "conf", `${s.genre} · 確度${(s.confidence * 100) | 0}%`));
  c.append(h, defs([["観察", s.observation], ["根拠", s.reasoning], ["操作", s.action]]));

  if (s.command) c.append(el("div", "cmd", "$ " + s.command));
  c.append(defs([["結果", s.outcome]]));

  if (s.learn) {
    const l = el("div", "learn");
    l.append(el("b", undefined, "補足 "), document.createTextNode(s.learn));
    c.append(l);
  }
  c.append(...attachments(s));
  return c;
}

/**
 * 手順に添えられた画像。
 * ステガノでは「ビット面はこう見える」を示すことが説明そのものなので、
 * 文章の脇役ではなく本文として大きく出す。
 */
export function attachments(s: Step): HTMLElement[] {
  if (!s.attachments?.length) return [];
  return s.attachments.map((a) => {
    const fig = el("figure", "attach");
    const img = el("img");
    img.src = a.pngDataUrl;
    img.alt = a.label;
    // data URL は既に手元にあるので遅延読み込みは何も節約しない。
    // 逆に、ビューポート判定が絡むぶん「表示されないまま」になる失敗経路が増える。
    fig.append(img, el("figcaption", undefined, a.label));
    return fig;
  });
}

export function renderFull(steps: Step[]): HTMLElement {
  const wrap = el("div");
  const shown = steps.filter((s) => s.confidence >= 0.4);
  (shown.length ? shown : steps).forEach((s, i) => wrap.append(stepCard(s, i)));
  return wrap;
}

/**
 * ヒント中に現れるフラグを伏せる。
 *
 * アナライザの観察文は「XORすると flag{...} が出現」のように
 * 結果をそのまま書く。全解説ではそれでよいが、ヒントとして出すと
 * 答えを渡してしまい、伏せている意味が無くなる。
 * 手がかり（どの手を打てばよいか）は残したまま、答えだけを潰す。
 */
function redactFlags(text: string): string {
  return text.replace(/[A-Za-z][A-Za-z0-9_.\-]{1,20}\{[\x20-\x7e]{1,200}?\}/g, (m) => {
    const prefix = m.slice(0, m.indexOf("{") + 1);
    return prefix + "█".repeat(Math.min(12, m.length - prefix.length - 1)) + "}";
  });
}

/**
 * ヒント表示。1手ずつしか見せない。
 * 全部見せてしまうと「次に何を試すか」を自分で考える機会が消える。
 */
export function renderHints(steps: Step[], shown: number, onMore: () => void): HTMLElement {
  const wrap = el("div");
  if (!steps.length) {
    wrap.append(el("div", "done", "有力な手がかりが得られませんでした。「全解説」で試行の全記録を確認できます。"));
    return wrap;
  }
  steps.slice(0, shown).forEach((s, i) => {
    const c = el("div", "hint");
    c.append(el("div", "label", `ヒント ${i + 1} / ${steps.length}`));
    c.append(el("p", undefined, redactFlags(s.observation.split("\n")[0])));
    c.append(el("p", "learn", redactFlags(s.reasoning)));
    if (s.command) c.append(el("div", "cmd", "$ " + s.command));
    c.append(...attachments(s));
    wrap.append(c);
  });
  if (shown < steps.length) {
    const more = el("button", "more", `次のヒントを見る（残り ${steps.length - shown}）`);
    more.addEventListener("click", onMore);
    wrap.append(more);
  } else {
    wrap.append(el("div", "done", "ヒントは以上です。ここまでの手順で解けましたか？"));
  }
  return wrap;
}

export function renderTree(root: NodeView): HTMLElement {
  const wrap = el("div", "tree");
  const walk = (n: NodeView, prefix: string, connector: string, childPrefix: string) => {
    const line = el("div");
    line.append(document.createTextNode(prefix + connector),
                el("span", "n", n.label),
                el("span", "k", `  [${n.kind}, ${fmtSize(n.size)}]`));
    wrap.append(line);
    n.children.forEach((c, i) => {
      const last = i === n.children.length - 1;
      walk(c, childPrefix, last ? "└─ " : "├─ ", childPrefix + (last ? "   " : "│  "));
    });
  };
  walk(root, "", "", "");
  return wrap;
}

export function flagRow(f: FlagHit): HTMLElement {
  const row = el("div", "flag");
  const copy = el("button", undefined, "コピー");
  copy.addEventListener("click", async () => {
    await navigator.clipboard.writeText(f.value);
    copy.textContent = "コピー済";
    setTimeout(() => (copy.textContent = "コピー"), 1200);
  });
  row.append(el("code", undefined, f.value),
             el("span", "meta", `${(f.confidence * 100) | 0}% ${f.where}`), copy);
  return row;
}
