import type { Skill, Instance, Progress } from "../src/curriculum/types.ts";
import type { ReportView } from "../src/core/view.ts";
import {
  SKILLS, SKILLS_BY_ID, GENERATORS_BY_SKILL, LEVEL_LABEL,
  instantiate, isUnlocked, isPlayable, loadProgress, saveProgress, orderedSkills,
} from "../src/curriculum/index.ts";
import { el, $, download, fmtSize } from "./dom.ts";
import { analyzeBytes } from "./analyzer.ts";
import { renderHints, renderFull } from "./render.ts";

let progress: Progress = loadProgress();
let root: HTMLElement;

export function initLearnView(): void {
  root = $<HTMLElement>("learn-body");
  showTree();
}

// ══════════ スキル一覧 ══════════
function showTree() {
  const wrap = el("div");
  const playable = SKILLS.filter(isPlayable);
  const cleared = playable.filter((s) => (progress.solved[s.id] ?? 0) > 0);

  const head = el("div", "progress-card");
  head.append(el("div", "progress-num", `${cleared.length} / ${playable.length}`));
  head.append(el("div", "dim", "スキル習得数"));
  const bar = el("div", "bar");
  const fill = el("div", "bar-fill");
  fill.style.width = `${playable.length ? (cleared.length / playable.length) * 100 : 0}%`;
  bar.append(fill);
  head.append(bar);
  if (cleared.length) {
    const reset = el("button", "linkish", "進捗をリセット");
    reset.addEventListener("click", () => {
      if (!confirm("習得済みのスキルを全て未習得に戻します。よろしいですか？")) return;
      progress = { solved: {}, hintsUsed: {}, updatedAt: Date.now() };
      saveProgress(progress);
      showTree();
    });
    head.append(reset);
  }
  wrap.append(head);

  // レベルごとに区切って並べる。次に何をやればいいかが一目で分かるように
  const byLevel = new Map<number, Skill[]>();
  for (const s of orderedSkills()) {
    if (!byLevel.has(s.level)) byLevel.set(s.level, []);
    byLevel.get(s.level)!.push(s);
  }
  for (const [level, skills] of [...byLevel].sort((a, b) => a[0] - b[0])) {
    wrap.append(el("h3", "level-head", `Lv${level}　${LEVEL_LABEL[level as 0]}`));
    const grid = el("div", "skill-grid");
    for (const s of skills) grid.append(skillCard(s));
    wrap.append(grid);
  }
  root.replaceChildren(wrap);
}

function skillCard(s: Skill): HTMLElement {
  const solved = progress.solved[s.id] ?? 0;
  const unlocked = isUnlocked(s, progress);
  const playable = isPlayable(s);

  const card = el("button", "skill-card");
  card.dataset.genre = s.genre;
  if (solved > 0) card.classList.add("solved");
  if (!playable) card.classList.add("planned");
  else if (!unlocked) card.classList.add("locked");

  const title = el("div", "skill-title");
  title.append(document.createTextNode(s.title));
  if (solved > 0) title.append(el("span", "check", "✓"));
  card.append(title, el("div", "skill-sum", s.summary));

  const foot = el("div", "skill-foot");
  foot.append(el("span", "genre-tag", s.genre));
  if (!playable) foot.append(el("span", "dim", "構想段階"));
  else if (!unlocked) {
    const need = s.requires.map((r) => SKILLS_BY_ID.get(r)?.title ?? r).join("・");
    foot.append(el("span", "dim", `要: ${need}`));
  } else {
    foot.append(el("span", "dim", `練習問題 ${(GENERATORS_BY_SKILL[s.id] ?? []).length} 種`));
  }
  card.append(foot);

  // 未開放でも解説は読める。前提を課すのは順序の案内であって、閲覧の制限ではない
  card.addEventListener("click", () => showSkill(s));
  return card;
}

// ══════════ スキル詳細（読み物） ══════════
function showSkill(s: Skill) {
  const wrap = el("div");
  wrap.append(backButton("スキル一覧へ", showTree));

  const head = el("div", "skill-head");
  head.append(el("span", "genre-tag", s.genre), el("span", "dim", `Lv${s.level} ${LEVEL_LABEL[s.level]}`));
  wrap.append(head, el("h2", "skill-h", s.title), el("p", "skill-sum-lg", s.summary));

  wrap.append(section("なぜそうするのか", s.concept.why));
  wrap.append(section("どうやるのか", s.concept.how));

  const cmds = el("div", "panel");
  cmds.append(el("h4", undefined, "覚えるコマンド"));
  for (const c of s.concept.commands) {
    cmds.append(el("div", "cmd", "$ " + c.cmd), el("p", "cmd-what", c.what));
  }
  wrap.append(cmds);

  const pit = el("div", "panel");
  pit.append(el("h4", undefined, "つまずきどころ"));
  const ul = el("ul", "pitfalls");
  for (const p of s.concept.pitfalls) ul.append(el("li", undefined, p));
  pit.append(ul);
  wrap.append(pit);

  const gens = GENERATORS_BY_SKILL[s.id] ?? [];
  if (!isPlayable(s)) {
    wrap.append(el("div", "status", "このスキルの練習問題はまだ用意できていません。解説だけ先に読めます。"));
  } else {
    const box = el("div", "panel");
    box.append(el("h4", undefined, "練習問題"));
    box.append(el("p", "dim", "問題はその場で生成されます。毎回フラグが変わるので、答えを調べても意味がありません。"));
    for (const g of gens) {
      const b = el("button", "gen-btn");
      b.append(el("span", "gen-title", g.title), el("span", "diff", "★".repeat(g.difficulty)));
      b.addEventListener("click", () => void startChallenge(s, g.id));
      box.append(b);
    }
    wrap.append(box);
  }
  root.replaceChildren(wrap);
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function section(title: string, body: string): HTMLElement {
  const d = el("div", "panel");
  d.append(el("h4", undefined, title), el("p", undefined, body));
  return d;
}

// ══════════ 問題を解く ══════════
async function startChallenge(skill: Skill, generatorId: string) {
  const inst = await instantiate(generatorId);
  showChallenge(skill, inst);
}

function showChallenge(skill: Skill, inst: Instance) {
  let report: ReportView | null = null;
  let hintsShown = 0;
  let solved = false;

  const wrap = el("div");
  wrap.append(backButton(`「${skill.title}」へ戻る`, () => showSkill(skill)));
  wrap.append(el("h2", "skill-h", inst.filename));
  wrap.append(el("p", "skill-sum-lg", inst.prompt));

  // ファイルを渡す。自分の手元のツールで解いてもらうのが本筋
  const dl = el("button", "primary", `${inst.filename} をダウンロード（${fmtSize(inst.bytes.length)}）`);
  const dlNote = el("p", "dim");
  dl.addEventListener("click", async () => {
    dl.disabled = true;
    const r = await download(inst.bytes, inst.filename);
    dl.disabled = false;
    if (!r.ok) {
      dlNote.textContent = r.reason ?? "保存できませんでした";
      return;
    }
    // 配布先の制限で名前を変えた場合は、元に戻す手順を伝える
    dlNote.textContent = r.savedAs && r.savedAs !== inst.filename
      ? `この環境では「${r.savedAs}」として保存されます。中身はそのままなので、mv ${r.savedAs} ${inst.filename} で元の名前に戻してから使ってください。`
      : "";
  });
  wrap.append(dl, dlNote);
  wrap.append(el("p", "dim", `seed=${inst.seed}　同じ種を使えば同じ問題を再現できます`));

  // 答え合わせ
  const form = el("div", "answer-form");
  const input = el("input", "flag-input");
  input.type = "text";
  // 画像に描かれた文字を読む問題は大文字。書式を実物に合わせないと入力で迷わせる
  const prefix = inst.flag.slice(0, inst.flag.indexOf("{"));
  input.placeholder = `${prefix}{...} を入力`;
  input.autocapitalize = "off";
  input.spellcheck = false;
  const submit = el("button", "primary", "答え合わせ");
  const verdict = el("div", "verdict");

  const check = () => {
    const v = input.value.trim();
    if (!v) return;
    if (v === inst.flag) {
      solved = true;
      verdict.className = "verdict ok";
      verdict.textContent = "正解。";
      progress.solved[skill.id] = (progress.solved[skill.id] ?? 0) + 1;
      saveProgress(progress);
      wrap.append(afterSolve(skill));
    } else if (v.toLowerCase() === inst.flag.toLowerCase()) {
      // 内容は合っている。CTFのフラグは大文字小文字を区別するので、そこだけ指摘する
      verdict.className = "verdict ng";
      verdict.textContent = `中身は合っています。フラグは大文字と小文字を区別するので、${prefix}{...} の字種のまま入力してください。`;
    } else {
      verdict.className = "verdict ng";
      verdict.textContent = v.includes("{")
        ? "違います。フラグの形は合っているので、もう少しです。"
        : `違います。フラグは ${prefix}{...} の形をしています。`;
    }
  };
  submit.addEventListener("click", check);
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") check(); });
  form.append(input, submit);
  wrap.append(form, verdict);

  // ヒント。使っても罰しないが、使った回数は記録する
  const hintBox = el("div", "panel");
  const hintBtn = el("button", "more", "詰まった — ヒントを見る");
  hintBtn.addEventListener("click", async () => {
    if (!report) {
      hintBtn.textContent = "解析中…";
      hintBtn.disabled = true;
      report = await analyzeBytes(inst.bytes, inst.filename);
      hintBtn.disabled = false;
    }
    hintsShown++;
    progress.hintsUsed[skill.id] = (progress.hintsUsed[skill.id] ?? 0) + 1;
    saveProgress(progress);
    renderHintArea();
  });
  const hintArea = el("div");
  hintBox.append(hintBtn, hintArea);
  wrap.append(hintBox);

  const renderHintArea = () => {
    if (!report) return;
    hintBtn.hidden = true;
    hintArea.replaceChildren(renderHints(report.keySteps, hintsShown, () => { hintsShown++; renderHintArea(); }));
    // ヒントを出し切ったら、初めて全解説への導線を出す
    if (hintsShown >= report.keySteps.length && !hintArea.querySelector(".full-btn")) {
      const full = el("button", "more full-btn", "全解説を読む（答えも表示されます）");
      full.addEventListener("click", () => {
        if (!solved) {
          verdict.className = "verdict ng";
          verdict.textContent = `答えは ${inst.flag} でした。解説を読んで、次は自力で解きましょう。`;
        }
        full.replaceWith(renderFull(report!.walkthrough));
      });
      hintArea.append(full);
    }
  };

  root.replaceChildren(wrap);
  window.scrollTo({ top: 0, behavior: "smooth" });
  input.focus();
}

/** 正解後の導線。次に何をやればいいかを示す */
function afterSolve(skill: Skill): HTMLElement {
  const box = el("div", "panel solved-box");
  box.append(el("h4", undefined, "習得"));

  // このスキルを前提にしていた、新たに開いたスキルを教える
  const opened = SKILLS.filter(
    (s) => isPlayable(s) && s.requires.includes(skill.id) && isUnlocked(s, progress) && !(progress.solved[s.id] > 0),
  );
  if (opened.length) {
    box.append(el("p", undefined, "次のスキルが開放されました。"));
    for (const s of opened) {
      const b = el("button", "gen-btn");
      b.append(el("span", "gen-title", s.title), el("span", "dim", s.summary));
      b.addEventListener("click", () => showSkill(s));
      box.append(b);
    }
  } else {
    box.append(el("p", undefined, "同じスキルの別の問題を解くと定着します。"));
  }
  const back = el("button", "more", "スキル一覧へ戻る");
  back.addEventListener("click", showTree);
  box.append(back);
  return box;
}

function backButton(label: string, onClick: () => void): HTMLElement {
  const b = el("button", "back", `← ${label}`);
  b.addEventListener("click", onClick);
  return b;
}
