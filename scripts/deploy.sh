#!/usr/bin/env bash
# GitHub Pages へ配信する。
# ソース(main)と配信物(gh-pages)を分けているので、ビルドしてgh-pagesへ差し替える。
set -euo pipefail
cd "$(dirname "$0")/.."

npm run build
touch dist/.nojekyll   # Pages の Jekyll 処理を通さない

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
REPO=$(git config --get remote.origin.url)

git clone -q --depth 1 --branch gh-pages "$REPO" "$WORK" 2>/dev/null || {
  git clone -q --depth 1 "$REPO" "$WORK"
  git -C "$WORK" checkout -q --orphan gh-pages
}
git -C "$WORK" rm -rqf . 2>/dev/null || true
cp -r dist/. "$WORK/"
git -C "$WORK" add -A
if git -C "$WORK" diff --cached --quiet; then
  echo "変更なし。配信済みの内容と同じです。"
  exit 0
fi
git -C "$WORK" commit -q -m "ビルド成果物を更新"
git -C "$WORK" push -q origin gh-pages
echo "配信しました → https://nozomu0929.github.io/hatatori/"
