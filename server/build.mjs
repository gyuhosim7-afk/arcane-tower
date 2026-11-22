// index.html(읽기 쉬운 원본)의 게임 코드를 암호화·난독화해서 server/public/index.html로 내보낸다.
// 친구가 사이트 소스를 봐도 뜯어보기 어렵게 만드는 용도. (서버 검증이 진짜 조작 방지)
import { readFileSync, writeFileSync, mkdirSync, cpSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import JsOb from "javascript-obfuscator";

const here = dirname(fileURLToPath(import.meta.url));
const srcPath = join(here, "..", "index.html");
const outDir = join(here, "public");
const html = readFileSync(srcPath, "utf8");

const a = html.indexOf("<script>");
const b = html.indexOf("</script>", a);
if (a < 0 || b < 0) throw new Error("script block not found");
const head = html.slice(0, a + "<script>".length);
const js = html.slice(a + "<script>".length, b);
const tail = html.slice(b);

const force = /const FORCE_ID=(\d+)/.exec(js);
const build = force ? force[1] : "0";

const result = JsOb.obfuscate(js, {
  compact: true,
  simplify: true,
  target: "browser",
  // 식별자를 _0x… 16진수 이름으로 (친구 게임과 같은 모양)
  identifierNamesGenerator: "hexadecimal",
  renameGlobals: true,
  // 문자열 암호화: 문자열을 배열로 빼고 base64로 숨긴다 (rc4는 매 프레임 비용이 커서 제외)
  stringArray: true,
  stringArrayEncoding: ["base64"],
  stringArrayThreshold: 0.8,
  stringArrayRotate: true,
  stringArrayShuffle: true,
  stringArrayWrappersType: "function",
  splitStrings: true,
  splitStringsChunkLength: 8,
  // 코드를 예쁘게 펴면 깨지도록 (뜯어보기 방해). 디버거 트랩은 성능/안정성 위해 끔
  selfDefending: true,
  disableConsoleOutput: true,
  numbersToExpressions: false,
  // 실시간 게임이라 프레임 떨어뜨리는 옵션은 끈다
  controlFlowFlattening: false,
  deadCodeInjection: false,
  transformObjectKeys: false,
  unicodeEscapeSequence: false,
}).getObfuscatedCode();

const out = head + "\n" + result + "\n" + tail.replace("</script>", `</script>\n<!--FORCE_ID=${build}-->`);
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "index.html"), out);
// GitHub Pages와 Worker 모두 난독화된 동일 빌드를 배포한다.
const assetsDir = join(here, "..", "assets");
if (existsSync(assetsDir)) cpSync(assetsDir, join(outDir, "assets"), { recursive: true, force: true });
const nojekyll = join(here, "..", ".nojekyll");
if (existsSync(nojekyll)) writeFileSync(join(outDir, ".nojekyll"), readFileSync(nojekyll));
console.log(`obfuscated build ${build}: ${(js.length / 1024) | 0}KB -> ${(result.length / 1024) | 0}KB`);
