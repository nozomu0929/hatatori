import { defineConfig } from "vite";

export default defineConfig({
  // 配信先のパスを問わないよう相対参照にする。
  // GitHub Pages のようにサブディレクトリ配下へ置かれても壊れない。
  base: "./",
  root: "web",
  publicDir: "../public",
  build: {
    outDir: "../dist",
    emptyOutDir: true,
    target: "es2022",
    // 単一HTMLとして配布できるよう、動的importも1つのチャンクにまとめる。
    // 1画面のアプリなので分割しても得るものがない。
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
  server: { port: 5180 },
});
