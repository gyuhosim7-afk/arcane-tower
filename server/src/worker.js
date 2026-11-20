// 아케인 타워 마을 서버: 같은 마을에 있는 친구들의 위치·채팅을 실시간으로 주고받는다.
import { DurableObject } from "cloudflare:workers";

const MAX_PLAYERS = 40;
const clean = (v, n) => String(v ?? "").replace(/[\u0000-\u001f<>]/g, "").slice(0, n);
const num = (v, lo, hi) => (Number.isFinite(+v) ? Math.max(lo, Math.min(hi, +v)) : lo);
const ELS = ["fire", "water", "ice", "wind", "earth", "thunder", "holy", "dark", "none"];

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === "/town") {
      if (req.headers.get("Upgrade") !== "websocket") return new Response("websocket only", { status: 426 });
      const ch = clean(url.searchParams.get("ch") || "1", 3).replace(/\D/g, "") || "1";
      return env.TOWN.get(env.TOWN.idFromName("town-" + ch)).fetch(req);
    }
    return new Response("arcane-tower town server ok", { headers: { "access-control-allow-origin": "*" } });
  },
};

export class Town extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('{"t":"ping"}', '{"t":"pong"}'));
  }
  async fetch() {
    if (this.ctx.getWebSockets().length >= MAX_PLAYERS) return new Response("full", { status: 503 });
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ id: crypto.randomUUID().slice(0, 8), p: null, lastChat: 0, n: 0, win: 0 });
    return new Response(null, { status: 101, webSocket: client });
  }
  others(ws) {
    return this.ctx.getWebSockets().filter((w) => w !== ws);
  }
  send(ws, o) {
    try { ws.send(JSON.stringify(o)); } catch {}
  }
  broadcast(from, o) {
    const s = JSON.stringify(o);
    for (const w of this.others(from)) try { w.send(s); } catch {}
  }
  async webSocketMessage(ws, raw) {
    const a = ws.deserializeAttachment();
    const now = Date.now();
    // 초당 30개 이상 보내면 무시 (도배 방지)
    if (now - a.win > 1000) { a.win = now; a.n = 0; }
    if (++a.n > 30 || typeof raw !== "string" || raw.length > 600) return;
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    if (m.t === "hi") {
      a.p = {
        id: a.id,
        nick: clean(m.nick, 12) || "마법사",
        title: clean(m.title, 16),
        el: ELS.includes(m.el) ? m.el : "none",
        job: clean(m.job, 10),
        lv: num(m.lv, 1, 999) | 0,
        rb: m.rb >= 0 && m.rb <= 6 ? m.rb | 0 : -1,
        x: num(m.x, 0, 4000), y: num(m.y, 0, 4000), f: m.f < 0 ? -1 : 1, w: 0,
      };
      ws.serializeAttachment(a);
      const list = this.others(ws).map((w) => w.deserializeAttachment().p).filter(Boolean);
      this.send(ws, { t: "all", me: a.id, list });
      this.broadcast(ws, { t: "join", p: a.p });
      return;
    }
    if (!a.p) return;
    if (m.t === "mv") {
      a.p.x = num(m.x, 0, 4000); a.p.y = num(m.y, 0, 4000); a.p.f = m.f < 0 ? -1 : 1; a.p.w = m.w ? 1 : 0;
      ws.serializeAttachment(a);
      this.broadcast(ws, { t: "mv", id: a.id, x: a.p.x, y: a.p.y, f: a.p.f, w: a.p.w });
    } else if (m.t === "chat") {
      const msg = clean(m.m, 80).trim();
      if (!msg || now - a.lastChat < 700) return;
      a.lastChat = now;
      ws.serializeAttachment(a);
      const o = { t: "chat", id: a.id, nick: a.p.nick, m: msg };
      this.broadcast(ws, o);
      this.send(ws, o);
    } else if (m.t === "info") {
      a.p.title = clean(m.title, 16); a.p.lv = num(m.lv, 1, 999) | 0;
      a.p.el = ELS.includes(m.el) ? m.el : a.p.el; a.p.job = clean(m.job, 10);
      ws.serializeAttachment(a);
      this.broadcast(ws, { t: "join", p: a.p });
    }
  }
  leave(ws) {
    const a = ws.deserializeAttachment();
    if (a && a.p) this.broadcast(ws, { t: "bye", id: a.id });
  }
  async webSocketClose(ws) { this.leave(ws); try { ws.close(); } catch {} }
  async webSocketError(ws) { this.leave(ws); }
}
