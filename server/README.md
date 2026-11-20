# 아케인 타워 서버 + 보호된 게임 (Cloudflare Workers)

- `src/worker.js` — 마을 멀티·계정·랭킹·PvP 서버.
- `build.mjs` — 읽기 쉬운 `../index.html`의 게임 코드를 **암호화·난독화**해서 `public/index.html`로 내보낸다.
- Worker가 `/` 에서 섞인 게임을, `/api/*`·`/town` 에서 서버를 내보낸다.

## 올리기 (반드시 빌드 먼저)
```
cd server
npm install            # 처음 한 번
node build.mjs         # index.html -> public/index.html (난독화)
npx wrangler deploy
```
또는 `npm run deploy` (빌드+배포 한 번에). `CLOUDFLARE_API_TOKEN` 환경변수 필요.

게임은 계속 루트의 `index.html`(읽기 쉬운 원본)에서 수정하고, 배포할 때 build.mjs가 섞어 준다.
친구가 보는 사이트(Worker 주소)에는 섞인 코드만 나간다. 진짜 조작 방지는 서버 검증이 담당한다.
