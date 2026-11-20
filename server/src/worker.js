// 아케인 타워 서버: 접속자 목록, 마을 위치·채팅, 귓속말, 파티, 거래.
// 전투와 저장은 각자 기기에서 하고, 서버는 친구끼리 메시지를 이어 준다.
import { DurableObject } from "cloudflare:workers";

const MAX_PLAYERS = 60;
const PARTY_MAX = 4;
const clean = (v, n) => String(v ?? "").replace(/[\u0000-\u001f<>]/g, "").slice(0, n);
const num = (v, lo, hi) => (Number.isFinite(+v) ? Math.max(lo, Math.min(hi, +v)) : lo);
const ELS = ["fire", "water", "ice", "wind", "earth", "thunder", "holy", "dark"];
const CORS = { "access-control-allow-origin": "*", "access-control-allow-methods": "POST, OPTIONS", "access-control-allow-headers": "content-type" };
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...CORS, "content-type": "application/json" } });
const ZONES = ["town", "tower", "underdeep", "udtown", "arena", "other"];

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/api/")) {
      if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
      if (req.method !== "POST") return json({ err: "method" }, 405);
      const ip = req.headers.get("CF-Connecting-IP") || "?";
      const body = await req.text();
      if (body.length > 600000) return json({ err: "big" }, 413);
      const r = await env.ACC.get(env.ACC.idFromName("acc")).fetch("https://acc" + url.pathname, { method: "POST", body, headers: { "x-ip": ip } });
      return new Response(r.body, { status: r.status, headers: { ...CORS, "content-type": "application/json" } });
    }
    if (url.pathname === "/town") {
      if (req.headers.get("Upgrade") !== "websocket") return new Response("websocket only", { status: 426 });
      return env.TOWN.get(env.TOWN.idFromName("town-1")).fetch(req);
    }
    return new Response("arcane-tower town server ok", { headers: { "access-control-allow-origin": "*" } });
  },
};

// 아이템 한 개를 안전한 모양으로 정리한다 (이상한 값은 버림).
function cleanItem(it) {
  if (!it || typeof it !== "object" || !["staff", "robe", "ring"].includes(it.slot)) return null;
  const o = { slot: it.slot, r: num(it.r, 0, 6) | 0, il: num(it.il, 1, 999) | 0, up: num(it.up, 0, 30) | 0, v: num(it.v, 0, 9) | 0, id: num(it.id, 0, 1e12) };
  if (it.my) o.my = clean(it.my, 24);
  o.a = {};
  for (const k of Object.keys(it.a || {}).slice(0, 12)) o.a[clean(k, 12)] = num(it.a[k], -1e6, 1e6);
  for (const k of ["pot", "epot"]) {
    const j = it[k] && typeof it[k] === "object" ? JSON.stringify(it[k]) : "";
    if (j && j.length < 1500) o[k] = JSON.parse(j);
  }
  return o;
}

export class Town extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('{"t":"ping"}', '{"t":"pong"}'));
  }
  async fetch() {
    if (this.ctx.getWebSockets().length >= MAX_PLAYERS) return new Response("full", { status: 503 });
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ u: null, id: crypto.randomUUID().slice(0, 8), p: null, lastChat: 0, n: 0, win: 0, party: null, pinv: null, treq: null, trade: null });
    return new Response(null, { status: 101, webSocket: client });
  }
  all() {
    return this.ctx.getWebSockets().map((w) => ({ w, a: w.deserializeAttachment() })).filter((x) => x.a && x.a.p);
  }
  find(id) {
    return this.all().find((x) => x.a.id === id);
  }
  send(ws, o) {
    try { ws.send(JSON.stringify(o)); } catch {}
  }
  sendTo(list, o) {
    const s = JSON.stringify(o);
    for (const x of list) try { x.w.send(s); } catch {}
  }
  save(x) {
    x.w.serializeAttachment(x.a);
  }
  partyList(pid) {
    return pid ? this.all().filter((x) => x.a.party === pid) : [];
  }
  partySync(pid) {
    let mem = this.partyList(pid);
    if (mem.length === 1) { mem[0].a.party = null; this.save(mem[0]); this.send(mem[0].w, { t: "party", members: [] }); return; }
    if (mem.length && !mem.some((x) => x.a.id === pid)) {
      // 파티장이 나가면 남은 사람 중 한 명이 파티장
      const np = mem[0].a.id;
      for (const x of mem) { x.a.party = np; this.save(x); }
      pid = np; mem = this.partyList(pid);
    }
    this.sendTo(mem, { t: "party", members: mem.map((x) => x.a.id), lead: pid });
  }
  async tradeClose(x, why) {
    const tr = x.a.trade;
    if (!tr) return;
    x.a.trade = null; this.save(x);
    await this.ctx.storage.delete("off:" + x.a.id);
    this.send(x.w, { t: "tclose", why });
    const o = this.find(tr.with);
    if (o && o.a.trade && o.a.trade.with === x.a.id) {
      o.a.trade = null; this.save(o);
      await this.ctx.storage.delete("off:" + o.a.id);
      this.send(o.w, { t: "tclose", why });
    }
  }
  async webSocketMessage(ws, raw) {
    const a = ws.deserializeAttachment();
    const x = { w: ws, a };
    const now = Date.now();
    if (now - a.win > 1000) { a.win = now; a.n = 0; }
    if (++a.n > 70 || typeof raw !== "string" || raw.length > 20000) return;
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    const others = () => this.all().filter((y) => y.a.id !== a.id);

    if (m.t === "hi") {
      const who = await this.env.ACC.get(this.env.ACC.idFromName("acc")).fetch("https://acc/api/whoami", { method: "POST", body: JSON.stringify({ token: String(m.token || "") }) }).then((r) => r.json()).catch(() => ({}));
      if (!who.u) { this.send(ws, { t: "sys", m: "로그인이 필요합니다" }); try { ws.close(4001, "auth"); } catch {} return; }
      for (const y of this.all()) if (y.a.u === who.u && y.w !== ws) { try { y.w.close(4002, "dup"); } catch {} await this.leave(y.w); }
      a.u = who.u; m.nick = who.name;
      a.p = {
        id: a.id, pid: clean(m.pid, 12), nick: clean(m.nick, 12) || "마법사", title: clean(m.title, 16),
        el: ELS.includes(m.el) ? m.el : "fire", job: clean(m.job, 10), lv: num(m.lv, 1, 999) | 0,
        rb: m.rb >= 0 && m.rb <= 6 ? m.rb | 0 : -1, zone: ZONES.includes(m.zone) ? m.zone : "other", fl: num(m.fl, 0, 999) | 0,
        hp: num(m.hp, 0, 1e9), mhp: num(m.mhp, 1, 1e9), x: num(m.x, 0, 4000), y: num(m.y, 0, 4000), f: m.f < 0 ? -1 : 1, w: 0,
      };
      this.save(x);
      this.send(ws, { t: "all", me: a.id, list: others().map((y) => y.a.p) });
      this.sendTo(others(), { t: "join", p: a.p });
      return;
    }
    if (!a.p) return;

    if (m.t === "mv") {
      a.p.x = num(m.x, 0, 4000); a.p.y = num(m.y, 0, 4000); a.p.f = m.f < 0 ? -1 : 1; a.p.w = m.w ? 1 : 0;
      this.save(x);
      this.sendTo(others().filter((y) => y.a.p.zone === a.p.zone), { t: "mv", id: a.id, x: a.p.x, y: a.p.y, f: a.p.f, w: a.p.w });
    } else if (m.t === "st") {
      const p = a.p;
      p.zone = ZONES.includes(m.zone) ? m.zone : p.zone; p.fl = num(m.fl, 0, 999) | 0;
      p.hp = num(m.hp, 0, 1e9); p.mhp = num(m.mhp, 1, 1e9); p.lv = num(m.lv, 1, 999) | 0;
      p.title = clean(m.title, 16); p.el = ELS.includes(m.el) ? m.el : p.el; p.job = clean(m.job, 10);
      p.rb = m.rb >= 0 && m.rb <= 6 ? m.rb | 0 : -1;
      if (m.x !== undefined) { p.x = num(m.x, 0, 4000); p.y = num(m.y, 0, 4000); }
      this.save(x);
      this.sendTo(others(), { t: "st", p });
    } else if (m.t === "chat") {
      const msg = clean(m.m, 80).trim();
      if (!msg || now - a.lastChat < 600) return;
      a.lastChat = now; this.save(x);
      const o = { t: "chat", id: a.id, nick: a.p.nick, m: msg, ch: m.ch === "p" ? "p" : "town" };
      if (o.ch === "p") { if (a.party) this.sendTo(this.partyList(a.party), o); }
      else this.sendTo(this.all().filter((y) => y.a.p.zone === a.p.zone), o);
    } else if (m.t === "w") {
      const msg = clean(m.m, 80).trim(), y = this.find(m.to);
      if (!msg || !y || now - a.lastChat < 600) return;
      a.lastChat = now; this.save(x);
      this.send(y.w, { t: "w", id: a.id, nick: a.p.nick, m: msg });
      this.send(ws, { t: "w", id: y.a.id, nick: y.a.p.nick, m: msg, me: 1 });
    }
    // 파티
    else if (m.t === "pinv") {
      const nm = String(m.name || "").trim().toLowerCase();
      const y = nm ? this.all().find((z) => z.a.u === nm || z.a.p.nick.toLowerCase() === nm) : this.find(m.to);
      if (!y && nm) return this.send(ws, { t: "sys", m: "접속 중인 사람 중에 그 닉네임이 없어요" });
      if (!y || y.a.party || y.a.id === a.id) return this.send(ws, { t: "sys", m: "초대할 수 없는 사람입니다" });
      if (a.party && this.partyList(a.party).length >= PARTY_MAX) return this.send(ws, { t: "sys", m: "파티가 가득 찼습니다" });
      y.a.pinv = a.id; this.save(y);
      this.send(y.w, { t: "pinv", from: a.id, nick: a.p.nick });
      this.send(ws, { t: "sys", m: y.a.p.nick + " 님에게 파티 초대를 보냈습니다" });
    } else if (m.t === "pacc") {
      const y = this.find(a.pinv);
      a.pinv = null;
      if (!y || a.party) { this.save(x); return this.send(ws, { t: "sys", m: "초대가 사라졌습니다" }); }
      if (!y.a.party) { y.a.party = y.a.id; this.save(y); }
      if (this.partyList(y.a.party).length >= PARTY_MAX) { this.save(x); return this.send(ws, { t: "sys", m: "파티가 가득 찼습니다" }); }
      a.party = y.a.party; this.save(x);
      this.partySync(a.party);
    } else if (m.t === "pno") {
      const y = this.find(a.pinv);
      a.pinv = null; this.save(x);
      if (y) this.send(y.w, { t: "sys", m: a.p.nick + " 님이 파티 초대를 거절했습니다" });
    } else if (m.t === "pleave") {
      const pid = a.party;
      if (!pid) return;
      a.party = null; this.save(x);
      this.send(ws, { t: "party", members: [] });
      this.partySync(pid);
    }
    // 파티 전투: 파티장 화면의 몬스터 정보와 파티원의 공격을 서로 전달
    else if (m.t === "prel") {
      if (!a.party || raw.length > 19000) return;
      const o = JSON.stringify({ t: "prel", from: a.id, d: m.d });
      for (const y of this.partyList(a.party)) if (y.a.id !== a.id) try { y.w.send(o); } catch {}
    }
    // 결투 (PvP)
    else if (m.t === "dreq") {
      const y = this.find(m.to);
      if (!y || y.a.id === a.id || y.a.duel || a.duel || y.a.trade || a.trade) return this.send(ws, { t: "sys", m: "지금은 결투할 수 없습니다" });
      if (y.a.p.zone !== "town" || a.p.zone !== "town") return this.send(ws, { t: "sys", m: "결투는 둘 다 마을에 있을 때만 됩니다" });
      y.a.dreq = a.id; this.save(y);
      this.send(y.w, { t: "dreq", from: a.id, nick: a.p.nick });
      this.send(ws, { t: "sys", m: y.a.p.nick + " 님에게 결투를 신청했습니다" });
    } else if (m.t === "dacc" || m.t === "dno") {
      const y = this.find(a.dreq);
      a.dreq = null; this.save(x);
      if (!y) return this.send(ws, { t: "sys", m: "결투 신청이 사라졌습니다" });
      if (m.t === "dno") return this.send(y.w, { t: "sys", m: a.p.nick + " 님이 결투를 거절했습니다" });
      if (y.a.duel || a.duel) return this.send(ws, { t: "sys", m: "상대가 다른 결투 중입니다" });
      a.duel = y.a.id; y.a.duel = a.id; this.save(x); this.save(y);
      this.send(y.w, { t: "dstart", with: a.id, nick: a.p.nick, el: a.p.el, rb: a.p.rb, side: 0 });
      this.send(ws, { t: "dstart", with: y.a.id, nick: y.a.p.nick, el: y.a.p.el, rb: y.a.p.rb, side: 1 });
    } else if (m.t === "drel") {
      const y = a.duel && this.find(a.duel);
      if (y && y.a.duel === a.id) this.send(y.w, { t: "drel", d: m.d });
    } else if (m.t === "dend") {
      const y = a.duel && this.find(a.duel);
      a.duel = null; this.save(x);
      if (y && y.a.duel === a.id) { y.a.duel = null; this.save(y); this.send(y.w, { t: "dend", res: ["lose", "time"].includes(m.res) ? m.res : "quit" }); }
    }
    // 거래
    else if (m.t === "treq") {
      const y = this.find(m.to);
      if (!y || y.a.id === a.id || y.a.trade || a.trade) return this.send(ws, { t: "sys", m: "지금은 거래할 수 없습니다" });
      if (y.a.p.zone !== "town" || a.p.zone !== "town") return this.send(ws, { t: "sys", m: "거래는 둘 다 마을에 있을 때만 됩니다" });
      y.a.treq = a.id; this.save(y);
      this.send(y.w, { t: "treq", from: a.id, nick: a.p.nick });
      this.send(ws, { t: "sys", m: y.a.p.nick + " 님에게 거래를 신청했습니다" });
    } else if (m.t === "tacc" || m.t === "tno") {
      const y = this.find(a.treq);
      a.treq = null; this.save(x);
      if (!y) return this.send(ws, { t: "sys", m: "거래 신청이 사라졌습니다" });
      if (m.t === "tno") return this.send(y.w, { t: "sys", m: a.p.nick + " 님이 거래를 거절했습니다" });
      if (y.a.trade || a.trade) return this.send(ws, { t: "sys", m: "상대가 다른 거래 중입니다" });
      a.trade = { with: y.a.id, ok: false }; y.a.trade = { with: a.id, ok: false };
      this.save(x); this.save(y);
      await this.ctx.storage.put("off:" + a.id, { items: [], gold: 0 });
      await this.ctx.storage.put("off:" + y.a.id, { items: [], gold: 0 });
      this.send(ws, { t: "topen", with: y.a.id, nick: y.a.p.nick });
      this.send(y.w, { t: "topen", with: a.id, nick: a.p.nick });
    } else if (m.t === "toff") {
      const y = a.trade && this.find(a.trade.with);
      if (!y) return this.tradeClose(x, "상대가 사라졌습니다");
      const items = (Array.isArray(m.items) ? m.items : []).slice(0, 8).map(cleanItem).filter(Boolean);
      const off = { items, gold: num(m.gold, 0, 1e12) | 0 };
      await this.ctx.storage.put("off:" + a.id, off);
      a.trade.ok = false; y.a.trade.ok = false; this.save(x); this.save(y);
      this.send(y.w, { t: "toff", items: off.items, gold: off.gold });
      this.send(ws, { t: "tst", me: false, them: false });
      this.send(y.w, { t: "tst", me: false, them: false });
    } else if (m.t === "tok") {
      const y = a.trade && this.find(a.trade.with);
      if (!y) return this.tradeClose(x, "상대가 사라졌습니다");
      a.trade.ok = true; this.save(x);
      if (y.a.trade && y.a.trade.ok) {
        const mine = (await this.ctx.storage.get("off:" + a.id)) || { items: [], gold: 0 };
        const theirs = (await this.ctx.storage.get("off:" + y.a.id)) || { items: [], gold: 0 };
        a.trade = null; y.a.trade = null; this.save(x); this.save(y);
        await this.ctx.storage.delete(["off:" + a.id, "off:" + y.a.id]);
        this.send(ws, { t: "tdone", give: mine, get: theirs, nick: y.a.p.nick });
        this.send(y.w, { t: "tdone", give: theirs, get: mine, nick: a.p.nick });
      } else {
        this.send(ws, { t: "tst", me: true, them: false });
        this.send(y.w, { t: "tst", me: false, them: true });
      }
    } else if (m.t === "tcancel") {
      await this.tradeClose(x, a.p.nick + " 님이 거래를 취소했습니다");
    }
  }
  async leave(ws) {
    const a = ws.deserializeAttachment();
    if (!a || !a.p) return;
    a.p = null; // 목록에서 빠지도록
    ws.serializeAttachment(a);
    if (a.trade) {
      const o = this.find(a.trade.with);
      if (o) { o.a.trade = null; this.save(o); this.send(o.w, { t: "tclose", why: "상대가 나갔습니다" }); await this.ctx.storage.delete("off:" + o.a.id); }
      await this.ctx.storage.delete("off:" + a.id);
    }
    if (a.duel) { const o = this.find(a.duel); if (o && o.a.duel === a.id) { o.a.duel = null; this.save(o); this.send(o.w, { t: "dend", res: "quit" }); } }
    this.sendTo(this.all(), { t: "bye", id: a.id });
    if (a.party) this.partySync(a.party);
  }
  async webSocketClose(ws) { await this.leave(ws); try { ws.close(); } catch {} }
  async webSocketError(ws) { await this.leave(ws); }
}

// ───────── 계정 (아이디·비밀번호, 서버 저장) ─────────
const enc = new TextEncoder();
const hex = (b) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
const rand = (n) => hex(crypto.getRandomValues(new Uint8Array(n)));
async function hashPw(pw, salt) {
  const key = await crypto.subtle.importKey("raw", enc.encode(pw), "PBKDF2", false, ["deriveBits"]);
  return hex(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: enc.encode(salt), iterations: 100000 }, key, 256));
}
function sameStr(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
const ID_RE = /^[가-힣a-z0-9_]{2,12}$/;
const PW_OK = (p) => p.length >= 8 && p.length <= 64 && /[a-zA-Z]/.test(p) && /[0-9]/.test(p);
const SLOTS = ["staff", "robe", "ring"];

// 저장 데이터 검사: 말도 안 되는 값이나 갑자기 뛴 진행도는 거부한다.
function checkSave(s, prev, dev, mins = 0) {
  if (!s || typeof s !== "object" || Array.isArray(s)) return "형식";
  const int = (v, lo, hi) => Number.isFinite(v) && v >= lo && v <= hi;
  if (!int(s.lvl, 1, 200) || !int(s.circle, 1, 9)) return "레벨";
  if (!int(s.gold, 0, 1e15) || !int(s.ess || 0, 0, 1e12) || !int(s.ore || 0, 0, 1e12)) return "재화";
  if (!int(s.maxFloor || 0, 0, 100) || !int(s.underdeepBestRoom || 0, 0, 20)) return "층";
  if (!Array.isArray(s.aff) || !s.aff.length || !Array.isArray(s.inv) || s.inv.length > (dev ? 64 : 32)) return "가방";
  const items = [...s.inv, ...Object.values(s.eq || {}).filter(Boolean)];
  for (const it of items) if (!it || !SLOTS.includes(it.slot) || !int(it.r, 0, 6) || !int(it.up || 0, 0, 15)) return "아이템";
  if (prev && !dev) {
    if (s.lvl - prev.lvl > 25 + mins * 3) return "레벨 급상승";
    if ((s.maxFloor || 0) - (prev.maxFloor || 0) > 10 + mins) return "층 급상승";
    if (prev.pid && s.pid !== prev.pid) return "캐릭터";
  }
  return null;
}

export class Accounts extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.fails = new Map(); // ip -> [count, until]
  }
  devUsers() {
    return String(this.env.DEV_USERS || "").split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);
  }
  async session(token) {
    if (typeof token !== "string" || token.length !== 64) return null;
    const t = await this.ctx.storage.get("tok:" + token);
    if (!t || t.exp < Date.now()) return null;
    const acc = await this.ctx.storage.get("u:" + t.u);
    if (!acc || acc.tok !== token) return null;
    return acc;
  }
  async newToken(acc) {
    if (acc.tok) await this.ctx.storage.delete("tok:" + acc.tok); // 다른 기기는 로그아웃
    acc.tok = rand(32);
    await this.ctx.storage.put("tok:" + acc.tok, { u: acc.u, exp: Date.now() + 1000 * 60 * 60 * 24 * 60 });
    await this.ctx.storage.put("u:" + acc.u, acc);
    return acc.tok;
  }
  limited(ip) {
    const f = this.fails.get(ip);
    return f && f[1] > Date.now() && f[0] >= 8;
  }
  fail(ip) {
    const f = this.fails.get(ip) || [0, 0];
    if (f[1] < Date.now()) { f[0] = 0; }
    f[0]++; f[1] = Date.now() + 10 * 60 * 1000;
    this.fails.set(ip, f);
  }
  async fetch(req) {
    const path = new URL(req.url).pathname, ip = req.headers.get("x-ip") || "?";
    let b;
    try { b = JSON.parse(await req.text()); } catch { return json({ err: "형식이 잘못됐어요" }, 400); }
    const dev = (u) => this.devUsers().includes(u);

    if (path === "/api/register" || path === "/api/login") {
      if (this.limited(ip)) return json({ err: "너무 많이 틀렸어요. 10분 뒤에 다시 해 주세요" }, 429);
      const name = String(b.u || "").trim().normalize("NFC"), u = name.toLowerCase(), p = String(b.p || "");
      if (!ID_RE.test(u)) return json({ err: "닉네임은 한글·영문·숫자·_ 2~12글자예요" }, 400);
      if (path === "/api/register" ? !PW_OK(p) : p.length < 1 || p.length > 64) return json({ err: "비밀번호는 8글자 이상, 영문과 숫자를 섞어 주세요" }, 400);
      let acc = await this.ctx.storage.get("u:" + u);
      if (path === "/api/register") {
        if (acc) return json({ err: "이미 있는 아이디예요" }, 409);
        const regs = (await this.ctx.storage.get("ipreg:" + ip)) || [];
        const recent = regs.filter((t) => t > Date.now() - 86400000);
        if (recent.length >= 15) return json({ err: "오늘은 이 인터넷에서 계정을 더 만들 수 없어요" }, 429);
        const salt = rand(16);
        acc = { u, name, salt, hash: await hashPw(p, salt), save: null, created: Date.now() };
        await this.ctx.storage.put("ipreg:" + ip, [...recent, Date.now()]);
      } else {
        if (!acc || !sameStr(await hashPw(p, acc.salt), acc.hash)) { this.fail(ip); return json({ err: "닉네임이나 비밀번호가 틀렸어요" }, 401); }
      }
      const token = await this.newToken(acc);
      return json({ ok: 1, u, name: acc.name || u, token, dev: dev(u), save: acc.save || null });
    }
    if (path === "/api/rank") {
      const rk = (await this.ctx.storage.get("rank")) || {};
      const list = Object.values(rk).sort((a, b) => b.lv - a.lv || b.fl - a.fl || b.ud - a.ud).slice(0, 50);
      return json({ ok: 1, list });
    }
    if (path === "/api/whoami") {
      const acc = await this.session(b.token);
      return json(acc ? { u: acc.u, name: acc.name || acc.u } : {});
    }
    const acc = await this.session(b.token);
    if (!acc) return json({ err: "session" }, 401);
    if (path === "/api/load") return json({ ok: 1, u: acc.u, name: acc.name || acc.u, dev: dev(acc.u), save: acc.save || null });
    if (path === "/api/logout") {
      await this.ctx.storage.delete("tok:" + acc.tok); acc.tok = null;
      await this.ctx.storage.put("u:" + acc.u, acc);
      return json({ ok: 1 });
    }
    if (path === "/api/save") {
      const s = b.save, why = checkSave(s, acc.save, dev(acc.u), (Date.now() - (acc.saved || 0)) / 60000);
      if (why) return json({ err: "bad", why }, 400);
      if (!acc.save && s.pid) {
        // 이 기기 캐릭터를 처음 올릴 때: 같은 캐릭터를 두 계정에 복사하지 못하게 막는다
        const owner = await this.ctx.storage.get("pid:" + s.pid);
        if (owner && owner !== acc.u) return json({ err: "bad", why: "이미 다른 계정에 있는 캐릭터예요" }, 409);
        await this.ctx.storage.put("pid:" + s.pid, acc.u);
      }
      acc.save = s; acc.saved = Date.now();
      await this.ctx.storage.put("u:" + acc.u, acc);
      const rk = (await this.ctx.storage.get("rank")) || {};
      const prevR = rk[acc.u], row = { n: acc.name || acc.u, lv: s.lvl | 0, fl: s.maxFloor | 0, ud: s.underdeepBestRoom | 0, el: String((s.aff || [])[0] || ""), job: String(s.job || ""), c: s.circle | 0 };
      if (!prevR || prevR.lv !== row.lv || prevR.fl !== row.fl || prevR.ud !== row.ud || prevR.job !== row.job || prevR.n !== row.n) { rk[acc.u] = row; await this.ctx.storage.put("rank", rk); }
      return json({ ok: 1 });
    }
    if (path === "/api/delchar") {
      acc.save = null;
      const rk = (await this.ctx.storage.get("rank")) || {};
      if (rk[acc.u]) { delete rk[acc.u]; await this.ctx.storage.put("rank", rk); }
      await this.ctx.storage.put("u:" + acc.u, acc);
      return json({ ok: 1 });
    }
    if (path === "/api/passwd") {
      if (!sameStr(await hashPw(String(b.old || ""), acc.salt), acc.hash)) return json({ err: "지금 비밀번호가 틀렸어요" }, 401);
      const p = String(b.p || "");
      if (!PW_OK(p)) return json({ err: "비밀번호는 8글자 이상, 영문과 숫자를 섞어 주세요" }, 400);
      acc.salt = rand(16); acc.hash = await hashPw(p, acc.salt);
      const token = await this.newToken(acc);
      return json({ ok: 1, token });
    }
    return json({ err: "없는 요청" }, 404);
  }
}
