// Claude 아티팩트용 빌드: 데모(혼자 플레이) + 관리자 패널을 HTML 한 파일에 모두 넣는다
//   node demo/build-artifact.mjs  →  demo/artifact/abyss-run.html
// 아티팩트는 외부 파일·스타일시트를 못 불러오므로 JS·CSS·폰트·스프라이트를 전부 인라인으로 넣는다.
import { build } from "esbuild";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const here = dirname(fileURLToPath(import.meta.url)), root = join(here, ".."), out = join(here, "artifact");
mkdirSync(out, { recursive: true });
const b64 = (f) => readFileSync(join(root, f)).toString("base64");
const ASSETS = {
  "/assets/dt2.png": `data:image/png;base64,${b64("public/assets/dt2.png")}`,
  "/assets/town.png": `data:image/png;base64,${b64("public/assets/town.png")}`,
};
const JSONS = {
  "/assets/dt2.json": readFileSync(join(root, "public/assets/dt2.json"), "utf8"),
  "/assets/town.json": readFileSync(join(root, "public/assets/town.json"), "utf8"),
};
const res = await build({
  entryPoints: [join(here, "entry-artifact.js")], bundle: true, format: "esm", target: "es2022", minify: true, write: false, legalComments: "eof",
  plugins: [{ name: "paths", setup(b) {
    b.onResolve({ filter: /^\/shared\// }, (a) => ({ path: join(root, a.path) }));
    b.onResolve({ filter: /(^|\/)db\.js$/ }, (a) => a.importer.includes("/server/") ? { path: join(here, "db-stub.js") } : undefined);
    // 스프라이트: 네트워크 대신 인라인 데이터
    b.onLoad({ filter: /render[\/\\]dt2\.js$/ }, (a) => {
      let src = readFileSync(a.path, "utf8");
      src = src.replace("fetch(json).then((r) => r.json())", "Promise.resolve(JSON.parse(__JSONS[json]))").replace("img.src = png;", "img.src = __ASSETS[png];");
      src = `const __ASSETS = ${JSON.stringify(ASSETS)};\nconst __JSONS = ${JSON.stringify(JSONS)};\n` + src;
      return { contents: src, loader: "js" };
    });
  } }],
});
let js = res.outputFiles[0].text.replace(/<\/script/gi, "<\\/script");
const font = (f) => `url(data:font/woff2;base64,${b64("public/fonts/" + f)}) format("woff2")`;
const css = readFileSync(join(root, "public/css/game.css"), "utf8").replace(/url\("\/fonts\/([^"]+)"\) format\("woff2"\)/g, (_, f) => font(f));
const html = readFileSync(join(root, "public/index.html"), "utf8");
const body = html.slice(html.indexOf("<body>") + 6, html.lastIndexOf("</body>")).replace('<script type="module" src="/js/main.js"></script>', "");
const page = `<title>Abyss Run</title>
<meta name="theme-color" content="#0b0a10" />
<style>
${css}
html,body{height:100%;background:#0b0a10}
</style>
${body}
<script type="module">
${js}
</script>
`;
writeFileSync(join(out, "abyss-run.html"), page);
console.log("built", join(out, "abyss-run.html"), (page.length / 1048576).toFixed(2) + "MB");
