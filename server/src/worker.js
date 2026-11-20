// 아케인 타워 서버: 접속자 목록, 마을 위치·채팅, 귓속말, 파티, 거래.
// 전투와 저장은 각자 기기에서 하고, 서버는 친구끼리 메시지를 이어 준다.
import { DurableObject } from "cloudflare:workers";

const MAX_PLAYERS = 60;
const PARTY_MAX = 4;
const clean = (v, n) => String(v ?? "").replace(/[\u0000-\u001f<>]/g, "").slice(0, n);
const num = (v, lo, hi) => (Number.isFinite(+v) ? Math.max(lo, Math.min(hi, +v)) : lo);
const ELS = ["fire", "water", "ice", "wind", "earth", "thunder", "holy", "dark"];
const ZONES = ["town", "tower", "underdeep", "udtown", "other"];

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
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
    server.serializeAttachment({ id: crypto.randomUUID().slice(0, 8), p: null, lastChat: 0, n: 0, win: 0, party: null, pinv: null, treq: null, trade: null });
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
    const mem = this.partyList(pid);
    if (mem.length === 1) { mem[0].a.party = null; this.save(mem[0]); this.send(mem[0].w, { t: "party", members: [] }); return; }
    this.sendTo(mem, { t: "party", members: mem.map((x) => x.a.id) });
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
    if (++a.n > 40 || typeof raw !== "string" || raw.length > 20000) return;
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    const others = () => this.all().filter((y) => y.a.id !== a.id);

    if (m.t === "hi") {
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
      p.rb = m.rb >= 0 && m.rb <= 6 ? m.rb | 0 : -1; p.nick = clean(m.nick, 12) || p.nick;
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
      const y = this.find(m.to);
      if (!y || y.a.party || y.a.id === a.id) return this.send(ws, { t: "sys", m: "초대할 수 없는 사람입니다" });
      if (a.party && this.partyList(a.party).length >= PARTY_MAX) return this.send(ws, { t: "sys", m: "파티가 가득 찼습니다" });
      y.a.pinv = a.id; this.save(y);
      this.send(y.w, { t: "pinv", from: a.id, nick: a.p.nick });
      this.send(ws, { t: "sys", m: y.a.p.nick + " 님에게 파티 초대를 보냈습니다" });
    } else if (m.t === "pacc") {
      const y = this.find(a.pinv);
      a.pinv = null;
      if (!y || a.party) { this.save(x); return this.send(ws, { t: "sys", m: "초대가 사라졌습니다" }); }
      if (!y.a.party) { y.a.party = crypto.randomUUID().slice(0, 8); this.save(y); }
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
    this.sendTo(this.all(), { t: "bye", id: a.id });
    if (a.party) this.partySync(a.party);
  }
  async webSocketClose(ws) { await this.leave(ws); try { ws.close(); } catch {} }
  async webSocketError(ws) { await this.leave(ws); }
}
