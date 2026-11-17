// 데모용 관리자(GM) 패널: 서버 /gm 페이지의 기능 중 혼자 플레이에서 의미 있는 것을 브라우저 안에서 바로 실행
// 비밀번호는 처음 연 사람이 정하고, SHA-256 해시만 이 브라우저(localStorage)에 저장한다.
import { rollItem, RARITIES, SLOTS, canEquip } from "../shared/items.js";
import { CLASS_INFO } from "../shared/classes.js";
import { MAX_LEVEL, ITEMS } from "../shared/constants.js";
import { secureRandom } from "../server/game/secure.js";
import { getWorld } from "./local-net.js";

const KEY = "psim_gm_hash";
const lsGet = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch {} };
async function sha(text) {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("psim-gm:" + text));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
}
const SLOT_NAMES = { weapon: "무기", offhand: "보조장비", helmet: "투구", armor: "갑옷", trinket: "장신구" };

const css = `
#gm-btn{position:fixed;z-index:9999;left:calc(8px + env(safe-area-inset-left,0px));bottom:calc(8px + env(safe-area-inset-bottom,0px));font:12px Galmuri11,monospace;background:#2a1636;color:#f3d27a;border:1px solid #f3d27a;padding:4px 8px;cursor:pointer;opacity:.75}
#gm-btn:hover{opacity:1}
#gm-panel{position:fixed;z-index:10000;left:calc(8px + env(safe-area-inset-left,0px));bottom:calc(40px + env(safe-area-inset-bottom,0px));width:min(320px,calc(100vw - 16px));max-height:calc(100vh - 60px);overflow:auto;background:#140e1c;color:#e8e2f0;border:1px solid #f3d27a;font:12px Galmuri11,monospace;padding:10px;box-shadow:0 4px 20px #000a}
#gm-panel h3{margin:0 0 8px;color:#f3d27a;font-size:14px}
#gm-panel fieldset{border:1px solid #4a3a5a;margin:0 0 8px;padding:6px 8px;display:grid;grid-template-columns:auto 1fr;gap:4px 6px;align-items:center}
#gm-panel legend{color:#c9a8ff;padding:0 4px}
#gm-panel input,#gm-panel select{font:inherit;background:#0b0810;color:#e8e2f0;border:1px solid #4a3a5a;padding:2px 4px;min-width:0}
#gm-panel button{font:inherit;background:#3a2450;color:#fff;border:1px solid #7a5aa0;padding:3px 8px;cursor:pointer;grid-column:1/-1}
#gm-panel button:hover{background:#4e3268}
#gm-panel .row{grid-column:1/-1;display:flex;gap:4px;flex-wrap:wrap}
#gm-panel .row button{flex:1}
#gm-msg{min-height:1.2em;color:#9fe0a0;margin-top:4px}
#gm-panel .err{color:#ff8a8a}
`;

function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) k === "on" ? Object.entries(v).forEach(([ev, f]) => e.addEventListener(ev, f)) : e.setAttribute(k, v);
  for (const k of kids) e.append(k);
  return e;
}

export function installGmPanel() {
  document.head.append(el("style", {}, css));
  const btn = el("button", { id: "gm-btn", type: "button", title: "관리자 패널" }, "GM");
  const panel = el("div", { id: "gm-panel", hidden: "" });
  document.body.append(btn, panel);
  // 패널 안에서 누른 키가 게임 조작으로 넘어가지 않게
  for (const ev of ["keydown", "keyup"]) panel.addEventListener(ev, (e) => e.stopPropagation());
  let authed = false;
  btn.addEventListener("click", () => { panel.hidden = !panel.hidden; if (!panel.hidden) authed ? drawMain() : drawLogin(); });

  const msg = (t, bad) => { const m = panel.querySelector("#gm-msg"); if (m) { m.textContent = t; m.className = bad ? "err" : ""; } };

  function drawLogin() {
    const first = !lsGet(KEY);
    panel.replaceChildren(
      el("h3", {}, first ? "관리자 비밀번호 정하기" : "관리자 로그인"),
      el("p", {}, first ? "처음 연 사람이 관리자 비밀번호를 정해요. (이 브라우저에만 저장)" : "관리자 비밀번호를 입력하세요."),
      el("form", { id: "gm-login", on: { submit: async (e) => {
        e.preventDefault();
        const pw = panel.querySelector("#gm-pw").value;
        if (pw.length < 4) return msg("비밀번호는 4자 이상이어야 해요.", true);
        const h = await sha(pw);
        if (first) { lsSet(KEY, h); authed = true; drawMain(); msg("관리자 비밀번호를 정했어요."); }
        else if (h === lsGet(KEY)) { authed = true; drawMain(); }
        else msg("비밀번호가 틀렸어요.", true);
      } } },
        el("fieldset", {}, el("label", { for: "gm-pw" }, "비밀번호"), el("input", { id: "gm-pw", type: "password", autocomplete: "off" }), el("button", { type: "submit" }, first ? "정하기" : "로그인"))),
      el("div", { id: "gm-msg" }),
    );
    panel.querySelector("#gm-pw").focus();
  }

  function session() {
    const w = getWorld();
    const s = w?.gmFind(1);
    if (!s) { msg("게임에 접속한 뒤 사용하세요.", true); return null; }
    return { w, s };
  }
  function apply(fn, done) {
    const x = session(); if (!x) return;
    x.w.gmApplyChar(1, fn);
    msg(done);
  }
  const num = (id) => { const v = panel.querySelector(id).value.trim(); return v === "" ? undefined : Number(v); };

  function drawMain() {
    const x = getWorld()?.gmFind(1);
    const c = x?.char ?? {};
    const classOpts = Object.entries(CLASS_INFO).map(([k, v]) => { const o = el("option", { value: k }, v.name); if (k === c.cls) o.selected = true; return o; });
    panel.replaceChildren(
      el("h3", {}, "관리자 패널"),
      el("fieldset", {}, el("legend", {}, "캐릭터"),
        el("label", { for: "gm-lv" }, `레벨 (1~${MAX_LEVEL})`), el("input", { id: "gm-lv", type: "number", min: 1, max: MAX_LEVEL, value: c.level ?? "" }),
        el("label", { for: "gm-gold" }, "골드"), el("input", { id: "gm-gold", type: "number", min: 0, max: 1e9, value: c.gold ?? "" }),
        el("label", { for: "gm-sp" }, "스탯 포인트"), el("input", { id: "gm-sp", type: "number", min: 0, max: 1000, value: c.unspent ?? "" }),
        el("label", { for: "gm-cp" }, "체크포인트"), el("input", { id: "gm-cp", type: "number", min: 1, max: 91, step: 10, value: c.checkpoint ?? "" }),
        el("label", { for: "gm-cls" }, "직업"), el("select", { id: "gm-cls" }, ...classOpts),
        el("button", { type: "button", on: { click: () => {
          const lv = num("#gm-lv"), gold = num("#gm-gold"), sp = num("#gm-sp"), cp = num("#gm-cp"), cls = panel.querySelector("#gm-cls").value;
          const ok = (v, lo, hi) => v === undefined || (Number.isInteger(v) && v >= lo && v <= hi);
          if (!ok(lv, 1, MAX_LEVEL) || !ok(gold, 0, 1e9) || !ok(sp, 0, 1000)) return msg("숫자 범위가 잘못됐어요.", true);
          if (cp !== undefined && (!ok(cp, 1, 91) || (cp - 1) % 10)) return msg("체크포인트는 1, 11, 21 … 91 이에요.", true);
          apply((ch) => {
            if (cls && cls !== ch.cls) {
              ch.unspent += Object.values(ch.stats ?? {}).reduce((a, v) => a + v, 0); ch.stats = {};
              ch.skills = ch.skills.map((k) => (k && k.startsWith("c_") ? k : null));
              for (const sl of ["weapon", "offhand"]) if (ch.equip[sl] && !canEquip(ch.equip[sl], cls)) { ch.inv.push(ch.equip[sl]); ch.equip[sl] = null; }
              ch.cls = cls;
            }
            if (lv !== undefined && lv !== ch.level) { ch.level = lv; ch.xp = 0; }
            if (gold !== undefined) ch.gold = gold;
            if (sp !== undefined) ch.unspent = sp;
            if (cp !== undefined) { ch.checkpoint = cp; ch.best = Math.max(ch.best ?? 0, cp - 1); }
          }, "캐릭터를 수정했어요.");
        } } }, "적용"),
        el("div", { class: "row" },
          el("button", { type: "button", on: { click: () => apply((ch) => { ch.cons = Object.fromEntries(Object.entries(ITEMS).map(([k, v]) => [k, v.max])); }, "소모품을 가득 채웠어요.") } }, "물약 가득"),
          el("button", { type: "button", on: { click: () => { const xx = session(); if (!xx) return; const u = xx.s.unit; u.hp = u.maxHp; if (u.mp != null) u.mp = u.maxMp; msg("체력·마나를 회복했어요."); } } }, "완전 회복"),
        ),
      ),
      el("fieldset", {}, el("legend", {}, "아이템 지급"),
        el("label", { for: "gm-rar" }, "등급"), el("select", { id: "gm-rar" }, ...RARITIES.map((r) => el("option", { value: r }, r))),
        el("label", { for: "gm-ilvl" }, "아이템 레벨"), el("input", { id: "gm-ilvl", type: "number", min: 1, max: 100, value: Math.min(100, Math.max(1, c.level ?? 1)) }),
        el("label", { for: "gm-slot" }, "부위"), el("select", { id: "gm-slot" }, el("option", { value: "" }, "아무거나"), ...SLOTS.map((s) => el("option", { value: s }, SLOT_NAMES[s] ?? s))),
        el("button", { type: "button", on: { click: () => {
          const rarity = panel.querySelector("#gm-rar").value, ilvl = num("#gm-ilvl") ?? 1, slot = panel.querySelector("#gm-slot").value;
          if (!(Number.isInteger(ilvl) && ilvl >= 1 && ilvl <= 100)) return msg("아이템 레벨은 1~100이에요.", true);
          let made = null;
          apply((ch) => {
            if (ch.inv.length >= 40) return;
            let it;
            for (let k = 0; k < 30; k++) { it = rollItem(secureRandom, { ilvl, cls: ch.cls, rarity }); if (!slot || it.slot === slot) break; }
            it.uid = ch.nextUid++; ch.inv.push(it); made = it;
          }, "");
          msg(made ? `지급: ${made.name ?? rarity + " 아이템"}` : "가방이 가득 찼어요.", !made);
        } } }, "지급"),
      ),
      el("fieldset", {}, el("legend", {}, "이동"),
        el("label", { for: "gm-floor" }, "층 (1~100)"), el("input", { id: "gm-floor", type: "number", min: 1, max: 100, value: 1 }),
        el("div", { class: "row" },
          el("button", { type: "button", on: { click: () => { const xx = session(); if (!xx) return; const f = num("#gm-floor"); if (!(Number.isInteger(f) && f >= 1 && f <= 100)) return msg("층은 1~100이에요.", true); xx.w.gmWarp(1, f); msg(`${f}층으로 이동했어요.`); } } }, "그 층으로"),
          el("button", { type: "button", on: { click: () => { const xx = session(); if (!xx) return; xx.w.gmTeleportTown(1); msg("마을로 이동했어요."); } } }, "마을로"),
        ),
      ),
      el("fieldset", {}, el("legend", {}, "공지"),
        el("label", { for: "gm-ann" }, "내용"), el("input", { id: "gm-ann", maxlength: 200 }),
        el("div", { class: "row" },
          el("button", { type: "button", on: { click: () => { const w = getWorld(); if (!w) return msg("게임에 접속한 뒤 사용하세요.", true); const t = panel.querySelector("#gm-ann").value.replace(/[<>]/g, "").trim(); w.gmAnnounce(t || null); msg(t ? "공지를 걸었어요." : "공지를 내렸어요."); } } }, "상단 공지"),
          el("button", { type: "button", on: { click: () => { const w = getWorld(); if (!w) return; const t = panel.querySelector("#gm-ann").value.replace(/[<>]/g, "").trim(); if (t) { w.broadcastSys(`[공지] ${t}`, "gm"); msg("채팅 공지를 보냈어요."); } } } }, "채팅 공지"),
        ),
      ),
      el("fieldset", {}, el("legend", {}, "관리자 비밀번호"),
        el("label", { for: "gm-newpw" }, "새 비밀번호"), el("input", { id: "gm-newpw", type: "password", autocomplete: "off" }),
        el("div", { class: "row" },
          el("button", { type: "button", on: { click: async () => { const p = panel.querySelector("#gm-newpw").value; if (p.length < 4) return msg("4자 이상으로 정해 주세요.", true); lsSet(KEY, await sha(p)); msg("비밀번호를 바꿨어요."); } } }, "바꾸기"),
          el("button", { type: "button", on: { click: () => { authed = false; panel.hidden = true; } } }, "로그아웃"),
        ),
      ),
      el("div", { id: "gm-msg" }),
    );
  }
}
