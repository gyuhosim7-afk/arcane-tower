// 아케인 타워 서버: 계정·저장·마을 통신과 서버 권한 게임 로직.
import { DurableObject } from "cloudflare:workers";
import { startEncounter, resolveAttack, resolveBlink, blinkCooldownMs, createServerCharacter, serverAttackPower, sanitizePartyHits, sanitizePartySnapshot, createPartyHealthState, applyPartyHits, partyHealthRows, partyHealthRecords, applyMonsterRewards, applyChestRewards, applyUnderdeepClearRewards, serverMythItem, allocateServerStat } from "./game-engine.js";

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
  if (!it || typeof it !== "object" || !SLOTS.includes(it.slot)) return null;
  const o = { slot: it.slot, r: num(it.r, 0, 6) | 0, il: num(it.il, 1, 200) | 0, up: num(it.up, 0, 15) | 0, v: num(it.v, 0, 9) | 0, id: num(it.id, 0, 1e12) };
  if (it.my) o.my = clean(it.my, 24);
  // 게임에 없는 모양(조작)인 아이템은 거래로 못 넘긴다
  if (itemLegit(o, false)) return null;
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
  // 결투 중 행동 속도 감시. 쿨타임보다 빠른 기본공격/순간이동은 위반으로 센다.
  // 주의: 이건 "정상 함수를 호출하되 쿨타임 값만 0으로 바꾼" 흔한 조작을 잡는다.
  // TODO(완성): 조작자가 blink()를 아예 안 거치고 좌표만 순간이동시키는 경우는,
  //   아래 'm'(이동) 중계에서 좌표 점프 거리/빈도를 재서 걸러야 한다. (지금은 뼈대만)
  pvpGuard(x, kind, now) {
    const a = x.a;
    // 각 행동의 최소 간격(ms). 기본공격 쿨 0.3s, 순간이동 쿨 2.5s → 약간의 네트워크 여유를 뺀 값.
    const MIN = kind === "s" ? 240 : kind === "bl" ? 2100 : 0;
    if (!MIN) return;
    const key = kind === "s" ? "dshot" : "dblk";
    const last = a[key] || 0;
    if (last && now - last < MIN) a.dviol = (a.dviol || 0) + 1;
    a[key] = now;
    this.save(x);
    // TODO(완성): a.dviol 가 즉시 강퇴 기준을 넘으면 여기서 ws.close(4003,"cheat") 로 끊고 결투 무효 처리.
  }
  async pvpRecord(wu, lu) {
    if (!wu || !lu || wu === lu) return;
    // 같은 두 사람끼리는 하루 10판까지만 기록 (점수 몰아주기 방지)
    const day = new Date().toISOString().slice(0, 10), key = [wu, lu].sort().join("|");
    this.pairs = this.pairs && this.pairs.day === day ? this.pairs : { day, n: {} };
    if ((this.pairs.n[key] = (this.pairs.n[key] || 0) + 1) > 10) return;
    await this.env.ACC.get(this.env.ACC.idFromName("acc")).fetch("https://acc/internal/pvp", { method: "POST", body: JSON.stringify({ w: wu, l: lu }) }).catch(() => {});
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
  async partySync(pid) {
    let mem = this.partyList(pid);
    if (!mem.length) { await this.ctx.storage.delete("party-health:" + pid); return; }
    if (mem.length === 1) {
      mem[0].a.party = null; this.save(mem[0]);
      this.send(mem[0].w, { t: "party", members: [] });
      await this.ctx.storage.delete("party-health:" + pid);
      return;
    }
    if (!mem.some((x) => x.a.id === pid)) {
      // 파티장이 나가면 새 파티장으로 교체하고 이전 전투 상태는 폐기한다.
      const oldPid = pid, np = mem[0].a.id;
      await this.ctx.storage.delete(["party-health:" + oldPid, "party-health:" + np]);
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
      await this.ctx.storage.delete("solo-health:" + who.u);
      a.blinkCooldownMs = num(who.blinkCooldownMs, 500, 10000);
      a.combatDamage = num(who.combatDamage, 1, 100000);
      a.combatLevel = num(who.combatLevel, 1, 200) | 0;
      a.blinkAt = 0;
      a.lastMoveAt = Date.now();
      a.p = {
        id: a.id, pid: clean(m.pid, 12), nick: clean(m.nick, 12) || "마법사", title: clean(m.title, 16),
        el: ELS.includes(m.el) ? m.el : "fire", job: clean(m.job, 10), lv: num(m.lv, 1, 999) | 0,
        rb: m.rb >= 0 && m.rb <= 6 ? m.rb | 0 : -1, zone: ZONES.includes(m.zone) ? m.zone : "other", fl: num(m.fl, 0, 999) | 0,
        hp: num(m.hp, 0, 1e9), mhp: num(m.mhp, 1, 1e9), x: num(m.x, 0, 4000), y: num(m.y, 0, 4000), f: m.f < 0 ? -1 : 1, w: 0,
      };
      this.save(x);
      this.send(ws, { t: "all", me: a.id, list: others().map((y) => y.a.p) });
      this.sendTo(others(), { t: "join", p: a.p });
      this.send(ws, { t: "solo", d: { k: "ready" } });
      return;
    }
    if (!a.p) return;

        if (m.t === "chest") {
      const zone = a.p.zone, floor = a.p.fl, kind = String(m.kind || "");
      if (m.zone !== zone || m.fl !== floor || !["tower", "underdeep"].includes(zone)) return;
      if (a.party) {
        const members = this.partyList(a.party), leader = members.find((y) => y.a.id === a.party);
        if (!leader || !leader.a.p || leader.a.p.zone !== zone || leader.a.p.fl !== floor) return this.send(ws, { t: "chest", ok: 0, kind, msg: "파티 전투 상태를 확인할 수 없습니다" });
      }
      const key = a.party ? "party-health:" + a.party : "solo-health:" + a.u;
      const state = await this.ctx.storage.get(key);
      if (!state || state.zone !== zone || state.floor !== floor || !state.cleared) return this.send(ws, { t: "chest", ok: 0, kind, msg: "서버가 층 클리어를 아직 확인하지 못했습니다" });
      if (!state.chestDecided) return this.send(ws, { t: "chest", ok: 0, kind, msg: "상자 보상 상태가 아직 확정되지 않았습니다" });
      if (zone === "underdeep" || floor % 5 === 0) {
        if (!state.bossKilled || kind !== "gold") return this.send(ws, { t: "chest", ok: 0, kind, msg: "보스 상자 조건이 충족되지 않았습니다" });
      } else if (state.eliteKilled) {
        if (kind !== "iron") return this.send(ws, { t: "chest", ok: 0, kind, msg: "정예 보상 상자 종류가 일치하지 않습니다" });
      } else if (!["wood", "iron"].includes(kind)) return this.send(ws, { t: "chest", ok: 0, kind, msg: "일반 상자 종류가 올바르지 않습니다" });
      const granted = await this.env.ACC.get(this.env.ACC.idFromName("acc")).fetch("https://acc/internal/chest-reward", {
        method: "POST",
        body: JSON.stringify({ u: a.u, zone, floor, kind }),
      }).then((r) => r.json()).catch(() => ({}));
      if (!granted.ok) return this.send(ws, { t: "chest", ok: 0, kind, msg: granted.err === "already_claimed" ? "이미 보상을 받았습니다" : "상자 보상 처리에 실패했습니다" });
      this.send(ws, { t: "chest", ok: 1, kind, fields: granted.fields, rewards: granted.rewards });
      return;
    }

    // 솔로 전투도 서버가 몬스터 HP와 처치 보상을 소유한다.
    if (m.t === "solo") {
      if (a.party || !m.d || typeof m.d !== "object" || raw.length > 19000) return;
      if (!["tower", "underdeep"].includes(a.p.zone)) return;
      if (m.d.k === "s") {
        if (now - (a.soloSnapshotAt || 0) < 80) return;
        const snapshot = sanitizePartySnapshot(m.d, a.p.zone, a.p.fl);
        if (!snapshot) return;
        a.soloSnapshotAt = now;
        const key = "solo-health:" + a.u;
        const previous = await this.ctx.storage.get(key);
        const state = createPartyHealthState(snapshot, previous, { zone: a.p.zone, floor: a.p.fl, level: a.combatLevel || 1, partySize: 1 }, now);
        updateServerClearState(state, snapshot, a.p.zone);
        await this.ctx.storage.put(key, state);
        this.send(ws, { t: "solo", d: { k: "auth", h: partyHealthRecords(state), kd: [] } });
        if (state.cleared && a.p.zone === "underdeep" && !state.clearRewardSent[a.u]) {
          const granted = await this.env.ACC.get(this.env.ACC.idFromName("acc")).fetch("https://acc/internal/underdeep-clear-reward", {
            method: "POST", body: JSON.stringify({ u: a.u, room: state.floor, runId: state.runId }),
          }).then((r) => r.json()).catch(() => ({}));
          if (granted.ok) {
            state.clearRewardSent[a.u] = true;
            await this.ctx.storage.put(key, state);
            this.send(ws, { t: "solo", d: { k: "loot", fields: granted.fields, rewards: granted.rewards } });
          }
        }
        this.save(x);
        return;
      }
      if (m.d.k === "h") {
        if (now - (a.soloHitAt || 0) < 180) return;
        a.soloHitAt = now;
        const hits = sanitizePartyHits(m.d.h, a.combatDamage, 8);
        if (!hits.length) return;
        const key = "solo-health:" + a.u;
        const state = await this.ctx.storage.get(key);
        if (!state || state.zone !== a.p.zone || state.floor !== a.p.fl) return;
        const resolved = applyPartyHits(state, hits);
        await this.ctx.storage.put(key, resolved.state);
        this.send(ws, { t: "solo", d: { k: "auth", h: partyHealthRecords(resolved.state), kd: resolved.kills } });
        for (const enemyId of resolved.kills) {
          const enemy = resolved.state.enemies[enemyId];
          if (!enemy) continue;
          const granted = await this.env.ACC.get(this.env.ACC.idFromName("acc")).fetch("https://acc/internal/party-reward", {
            method: "POST",
            body: JSON.stringify({ u: a.u, killId: crypto.randomUUID(), type: enemy.type, floor: resolved.state.floor, zone: resolved.state.zone, elite: !!enemy.elite }),
          }).then((r) => r.json()).catch(() => ({}));
          if (granted.ok && granted.fields) this.send(ws, { t: "solo", d: { k: "loot", fields: granted.fields, rewards: granted.rewards } });
        }
        this.save(x);
        return;
      }
      return;
    }

    if (m.t === "mv") {
      const nx = num(m.x, 0, 4000), ny = num(m.y, 0, 4000);
      const dt = Math.max(0.05, Math.min(0.75, (now - (a.lastMoveAt || now)) / 1000));
      const dist = Math.hypot(nx - a.p.x, ny - a.p.y);
      const walkLimit = 190 * dt + 14;
      if (dist > walkLimit) {
        if (dist > walkLimit + 78 || now - (a.blinkAt || 0) < (a.blinkCooldownMs || 2500)) { this.save(x); return; }
        a.blinkAt = now;
      }
      a.p.x = nx; a.p.y = ny; a.p.f = m.f < 0 ? -1 : 1; a.p.w = m.w ? 1 : 0;
      a.lastMoveAt = now;
      this.save(x);
      this.sendTo(others().filter((y) => y.a.p.zone === a.p.zone && y.a.p.fl === a.p.fl), { t: "mv", id: a.id, x: a.p.x, y: a.p.y, f: a.p.f, w: a.p.w });
    } else if (m.t === "st") {
      const p = a.p, oldZone = p.zone, oldFloor = p.fl;
      p.zone = ZONES.includes(m.zone) ? m.zone : p.zone; p.fl = num(m.fl, 0, 999) | 0;
      p.hp = num(m.hp, 0, 1e9); p.mhp = num(m.mhp, 1, 1e9); p.lv = num(m.lv, 1, 999) | 0;
      p.title = clean(m.title, 16); p.el = ELS.includes(m.el) ? m.el : p.el; p.job = clean(m.job, 10);
      p.rb = m.rb >= 0 && m.rb <= 6 ? m.rb | 0 : -1;
      // 같은 구역·층에서 상태 갱신 메시지로 좌표를 순간이동시키는 우회를 차단한다.
      if (m.x !== undefined && (p.zone !== oldZone || p.fl !== oldFloor)) {
        p.x = num(m.x, 0, 4000); p.y = num(m.y, 0, 4000); a.lastMoveAt = now; a.blinkAt = now;
      }
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
      await this.partySync(a.party);
    } else if (m.t === "pno") {
      const y = this.find(a.pinv);
      a.pinv = null; this.save(x);
      if (y) this.send(y.w, { t: "sys", m: a.p.nick + " 님이 파티 초대를 거절했습니다" });
    } else if (m.t === "pleave") {
      const pid = a.party;
      if (!pid) return;
      a.party = null; this.save(x);
      this.send(ws, { t: "party", members: [] });
      await this.partySync(pid);
    }
    // 파티 전투 중계: 파티장 스냅샷은 파티장만, 공격 요청은 파티원만 보낼 수 있다.
    // 파티원 피해량은 클라이언트 수치를 버리고 인증된 서버 캐릭터 능력치로 다시 계산한다.
    else if (m.t === "prel") {
      if (!a.party || !m.d || typeof m.d !== "object" || raw.length > 19000) return;
      const members = this.partyList(a.party);
      const leader = members.find((y) => y.a.id === a.party);
      if (!leader || !leader.a.p || !a.p) return;
      let d;
      if (m.d.k === "s" || m.d.k === "go") {
        if (a.id !== a.party) return;
        if (m.d.k === "go") {
          if (!["tower", "underdeep", "town"].includes(m.d.z) || !Number.isInteger(m.d.fl) || m.d.fl < 0 || m.d.fl > 999) return;
          d = { k: "go", z: m.d.z, fl: m.d.fl };
          await this.ctx.storage.put("party-health:" + a.party, { zone: m.d.z, floor: m.d.fl, enemies: {}, runId: crypto.randomUUID(), clearRewardSent: {} });
          this.send(ws, { t: "prel", from: a.id, d: { k: "ready" } });
        } else {
          if (now - (a.partySnapshotAt || 0) < 80) return;
          const snapshot = sanitizePartySnapshot(m.d, a.p.zone, a.p.fl);
          if (!snapshot) return;
          a.partySnapshotAt = now;
          const key = "party-health:" + a.party;
          const previous = await this.ctx.storage.get(key);
          const state = createPartyHealthState(snapshot, previous, { zone: a.p.zone, floor: a.p.fl, level: a.combatLevel || 1, partySize: members.length }, now);
           updateServerClearState(state, snapshot, a.p.zone);
          await this.ctx.storage.put(key, state);
          d = { ...snapshot, e: partyHealthRows(state), kd: [] };
          const auth = { t: "prel", from: a.id, d: { k: "auth", h: partyHealthRecords(state), kd: [] } };
          const recipients = members.filter((y) => y.a.p && y.a.p.zone === a.p.zone && y.a.p.fl === a.p.fl);
           this.sendTo(recipients, auth);
           if (state.cleared && a.p.zone === "underdeep") {
             for (const member of recipients) {
               const u = member.a.u;
               if (!u || state.clearRewardSent[u]) continue;
               const granted = await this.env.ACC.get(this.env.ACC.idFromName("acc")).fetch("https://acc/internal/underdeep-clear-reward", {
                 method: "POST", body: JSON.stringify({ u, room: state.floor, runId: state.runId }),
               }).then((r) => r.json()).catch(() => ({}));
               if (granted.ok) {
                 state.clearRewardSent[u] = true;
                 this.send(member.w, { t: "prel", from: a.id, d: { k: "loot", fields: granted.fields, rewards: granted.rewards } });
               }
             }
             await this.ctx.storage.put(key, state);
           }
          this.save(x);
        }
      } else if (m.d.k === "h") {
        if (!["tower", "underdeep"].includes(a.p.zone)) return;
        if (leader.a.p.zone !== a.p.zone || leader.a.p.fl !== a.p.fl) return;
        if (now - (a.partyHitAt || 0) < 180) return;
        a.partyHitAt = now;
        const hits = sanitizePartyHits(m.d.h, a.combatDamage, 8);
        if (!hits.length) return;
        const key = "party-health:" + a.party;
        const state = await this.ctx.storage.get(key);
        if (!state || state.zone !== a.p.zone || state.floor !== a.p.fl) return;
        const resolved = applyPartyHits(state, hits);
        await this.ctx.storage.put(key, resolved.state);
        const recipients = members.filter((y) => y.a.p && y.a.p.zone === a.p.zone && y.a.p.fl === a.p.fl);
        const result = { k: "auth", h: partyHealthRecords(resolved.state), kd: resolved.kills };
        this.sendTo(recipients, { t: "prel", from: a.id, d: result });
        // 처치가 서버에서 확정된 경우에만 각 계정에 개인 보상을 한 번 지급한다.
        for (const enemyId of resolved.kills) {
          const enemy = resolved.state.enemies[enemyId];
          if (!enemy) continue;
          const killId = crypto.randomUUID();
          for (const member of recipients) {
            if (!member.a.u) continue;
            const granted = await this.env.ACC.get(this.env.ACC.idFromName("acc")).fetch("https://acc/internal/party-reward", {
              method: "POST",
              body: JSON.stringify({ u: member.a.u, killId, type: enemy.type, floor: resolved.state.floor, zone: resolved.state.zone, elite: !!enemy.elite }),
            }).then((r) => r.json()).catch(() => ({}));
            if (granted.ok && granted.fields) this.send(member.w, { t: "prel", from: a.id, d: { k: "loot", fields: granted.fields, rewards: granted.rewards } });
          }
        }
        this.save(x);
        return;
      } else return;
      const o = JSON.stringify({ t: "prel", from: a.id, d });
      const recipients = d.k === "s"
        ? members.filter((y) => y.a.id !== a.id && y.a.p && y.a.p.zone === a.p.zone && y.a.p.fl === a.p.fl)
        : members.filter((y) => y.a.id !== a.id);
      for (const y of recipients) try { y.w.send(o); } catch {}
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
      a.duel = y.a.id; y.a.duel = a.id; a.dt0 = y.a.dt0 = Date.now(); a.dhp = y.a.dhp = 1000;
      // 결투 조작 감시용 (매 판 초기화)
      a.dviol = y.a.dviol = 0; a.dshot = y.a.dshot = 0; a.dblk = y.a.dblk = 0;
      a.dx = y.a.dx = a.dy = y.a.dy = a.dmt = y.a.dmt = a.dtp = y.a.dtp = 0; a._init = y.a._init = false;
      this.save(x); this.save(y);
      this.send(y.w, { t: "dstart", with: a.id, nick: a.p.nick, el: a.p.el, rb: a.p.rb, side: 0 });
      this.send(ws, { t: "dstart", with: y.a.id, nick: y.a.p.nick, el: y.a.p.el, rb: y.a.p.rb, side: 1 });
    } else if (m.t === "drel") {
      const y = a.duel && this.find(a.duel);
      if (m.d && m.d.k === "hp") { a.dhp = num(m.d.hp, 0, 1000); this.save(x); }
      // 쿨타임 조작 감시: 기본공격('s')/순간이동('bl') 이벤트가 쿨타임보다 빠르게 오면 위반으로 센다
      if (m.d && (m.d.k === "s" || m.d.k === "bl")) this.pvpGuard(x, m.d.k, Date.now());
      // 순간이동 조작 차단: 쿨타임 안 지났는데 걸음으로 설명 안 되는 위치 점프(=순간이동)는 상대에게 전달하지 않는다.
      // 그래서 조작으로 무한 순간이동해도 상대 화면에선 그 자리에 멈춰 보여 공격을 피할 수 없다.
      if (m.d && m.d.k === "m") {
        const now = Date.now(), nx = num(m.d.x, 0, 4000), ny = num(m.d.y, 0, 4000);
        if (a._init) {
          const dt = Math.max(0.02, (now - (a.dmt || now)) / 1000);
          const dist = Math.hypot(nx - a.dx, ny - a.dy);
          const walkMax = 95 * dt + 14; // 경기장 걸음 속도(여유 포함)
          if (dist > walkMax) {
            if (now - (a.dtp || 0) < 2100) {        // 순간이동 쿨타임(2.5s)이 아직 안 지남
              a.dviol = (a.dviol || 0) + 1; this.save(x);
              return;                                // 이 순간이동은 상대에게 전달 안 함
            }
            a.dtp = now;                             // 정상 순간이동 1회 허용
          }
        }
        a.dx = nx; a.dy = ny; a.dmt = now; a._init = true; this.save(x);
      }
      if (y && y.a.duel === a.id) this.send(y.w, { t: "drel", d: m.d });
    } else if (m.t === "dend") {
      const y = a.duel && this.find(a.duel);
      a.duel = null; this.save(x);
      if (y && y.a.duel === a.id) {
        y.a.duel = null; this.save(y); this.send(y.w, { t: "dend", res: ["lose", "time"].includes(m.res) ? m.res : "quit" });
        // 결과 기록: 진 쪽이 보낸 lose, 시간 종료면 서버가 본 체력으로 판정, 그 밖에는 나간 쪽이 패배
        let win = null, lose = null;
        if (m.res === "time") { if (a.dhp > y.a.dhp) { win = a; lose = y.a; } else if (y.a.dhp > a.dhp) { win = y.a; lose = a; } }
        else { win = y.a; lose = a; }
        // 이긴 쪽이 쿨타임 조작 의심(위반 누적)이면 랭킹에 기록하지 않는다 (조작 승리 무효)
        const CHEAT_VIOLATIONS = 8; // TODO(완성): 실제 플레이 로그 보며 숫자 조정
        if (win && (win.dviol || 0) >= CHEAT_VIOLATIONS) {
          this.send(win === a ? ws : y.w, { t: "sys", m: "비정상 행동이 감지되어 이 결투는 랭킹에 반영되지 않았습니다" });
          win = null;
          // TODO(완성): 상대(정상 플레이어)에게는 승리를 줄지, 그냥 무효로 둘지 결정. 반복 위반자는 ws.close()로 강퇴도 가능.
        }
        if (win && Date.now() - (a.dt0 || 0) > 5000) await this.pvpRecord(win.u, lose.u);
      }
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
      const offered = Array.isArray(m.items) ? m.items : [];
      if (offered.some((item) => Number(item && item.id) >= SERVER_ITEM_ID_BASE)) return this.send(ws, { t: "sys", m: "서버 소유 장비의 거래는 아직 이전 중입니다" });
      const items = offered.slice(0, 8).map(cleanItem).filter(Boolean);
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
    if (a.duel) { const o = this.find(a.duel); if (o && o.a.duel === a.id) { o.a.duel = null; this.save(o); this.send(o.w, { t: "dend", res: "quit" }); if (Date.now() - (a.dt0 || 0) > 5000) await this.pvpRecord(o.a.u, a.u); } }
    this.sendTo(this.all(), { t: "bye", id: a.id });
    if (a.party) await this.partySync(a.party);
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
const SLOTS = ["staff", "robe", "ring", "shoes"];
const CIRC_LVL = [0, 0, 10, 20, 32, 45, 58, 70, 82, 95]; // 서클 c 올리려면 레벨 CIRC_LVL[c] 이상
const REWARD_FIELDS = ["lvl", "xp", "pts", "st"];
const REWARD_SYNC_FIELDS = [...REWARD_FIELDS, "gold", "ess", "ore", "potScroll", "epotScroll", "hpPot", "mpPot", "prot", "inv", "uid"];
function pickRewardFields(save, keys) {
  const out = {};
  for (const key of keys) if (save && save[key] !== undefined) out[key] = JSON.parse(JSON.stringify(save[key]));
  return out;
}
const rewardFields = (save) => pickRewardFields(save, REWARD_FIELDS);
const rewardSyncFields = (save) => pickRewardFields(save, REWARD_SYNC_FIELDS);
function updateServerClearState(state, snapshot, zone) {
  const wasCleared = !!state.cleared;
  state.cleared = !!(snapshot.cl && state.seenEnemyCount > 0 && state.killCount >= state.seenEnemyCount && Object.values(state.enemies).every((enemy) => enemy.dead || enemy.hp <= 0));
  if (!snapshot.cl) {
    if (wasCleared) { state.runId = crypto.randomUUID(); state.clearRewardSent = {}; }
    state.chestKind = null;
    state.chestDecided = false;
  } else if (state.cleared && !state.chestDecided) {
    state.chestDecided = true;
    if (zone === "underdeep") state.chestKind = state.floor % 5 === 0 && state.bossKilled ? "gold" : null;
    else if (state.floor % 5 === 0) state.chestKind = state.bossKilled ? "gold" : null;
    else if (state.eliteKilled) state.chestKind = "iron";
    else { const roll = Math.random(); state.chestKind = roll < 0.06 ? "iron" : roll < 0.36 ? "wood" : null; }
  }
  return state;
}

const SERVER_ITEM_ID_BASE = 900_000_000_000;
function serverItemRecord(item) {
  return { slot: item.slot, r: item.r, il: item.il, v: item.v, my: item.my || null, a: JSON.parse(JSON.stringify(item.a || {})), active: true };
}
function listedItems(save) {
  return [...(Array.isArray(save && save.inv) ? save.inv : []), ...Object.values(save && save.eq || {}).filter(Boolean)];
}
function validateServerItemOwnership(save, account) {
  const seen = new Set(), ledger = account.serverItemLedger || {};
  for (const item of listedItems(save)) {
    const id = Number(item && item.id);
    if (!Number.isSafeInteger(id) || id < 1) return "invalid_item_id";
    if (seen.has(id)) return "duplicate_item_id";
    seen.add(id);
    if (id < SERVER_ITEM_ID_BASE) continue; // legacy/client items are migrated separately
    const record = ledger[String(id)];
    if (!record || !record.active) return "unowned_server_item";
    const sameBase = item.slot === record.slot && item.r === record.r && item.v === record.v && (item.my || null) === record.my;
    const sameStats = JSON.stringify(item.a || {}) === JSON.stringify(record.a || {});
    const sameLevel = item.il === record.il;
    const mythExpected = item.my ? serverMythItem(item.my, save.lvl) : null;
    const validMythLevel = !!(mythExpected && item.il === save.lvl && JSON.stringify(item.a || {}) === JSON.stringify(mythExpected.a));
    if (!sameBase || (!sameStats || !sameLevel) && !validMythLevel) return "server_item_modified";
    if (validMythLevel && (!sameStats || !sameLevel)) {
      record.il = item.il;
      record.a = JSON.parse(JSON.stringify(item.a || {}));
    }
  }
  return null;
}

const isUnique = (my) => typeof my === "string" && /^uq/.test(my);
// 아이템 하나가 게임에서 나올 수 있는 모양인지 검사 (조작 아이템 차단). dev면 통과.
function itemLegit(it, dev) {
  if (!it || typeof it !== "object") return "형식";
  if (!SLOTS.includes(it.slot)) return "슬롯";
  if (!Number.isFinite(it.r) || it.r < 0 || it.r > 6) return "등급";
  if (!Number.isFinite(it.il) || it.il < 1 || it.il > 200) return "아이템레벨";
  const up = it.up || 0;
  if (!Number.isFinite(up) || up < 0 || up > 15) return "강화";
  if (dev) return null;
  if (it.my) {
    if (up !== 0) return "신화강화";                                   // 신화/유니크는 강화 불가
    if (isUnique(it.my) ? it.r !== 6 : it.r !== 5) return "신화등급";   // 유니크=6, 신화=5 고정
  } else if (it.r > 4) {
    return "가짜전설";                                                 // 일반 아이템은 전설(4)까지만
  }
  return null;
}

// 저장 데이터 검사: 말도 안 되는 값이나 갑자기 뛴 진행도는 거부한다.
function checkSave(s, prev, dev, mins = 0) {
  if (!s || typeof s !== "object" || Array.isArray(s)) return "형식";
  const int = (v, lo, hi) => Number.isFinite(v) && v >= lo && v <= hi;
  if (!int(s.lvl, 1, 200) || !int(s.circle, 1, 9)) return "레벨";
  if (!int(s.gold, 0, dev ? 1e15 : 1e11) || !int(s.ess || 0, 0, 1e10) || !int(s.ore || 0, 0, 1e10)) return "재화";
  if (!int(s.maxFloor || 0, 0, 100) || !int(s.underdeepBestRoom || 0, 0, 20)) return "층";
  if (!Array.isArray(s.aff) || !s.aff.length || !Array.isArray(s.inv) || s.inv.length > (dev ? 64 : 32)) return "가방";
  const items = [...s.inv, ...Object.values(s.eq || {}).filter(Boolean)];
  for (const it of items) { const why = itemLegit(it, dev); if (why) return "아이템:" + why; }
  if (!dev) {
    // 서클은 레벨 조건을 넘겨야 올릴 수 있다
    if (s.lvl < (CIRC_LVL[s.circle] || 0)) return "서클-레벨";
    // 찍은 능력치 + 남은 포인트는 레벨로 얻은 포인트(레벨당 3점)를 넘을 수 없다
    const st = s.st || {}, spent = (st.int || 0) + (st.vit || 0) + (st.crit || 0) + (st.wis || 0);
    if (spent < 0 || (s.pts || 0) < 0) return "포인트";
    if (spent + (s.pts || 0) > (s.lvl - 1) * 3 + 3) return "포인트초과";
    // 소소한 보유 상한 (흔히 조작하는 값들)
    if (!int(s.blinkLv || 0, 0, 100) || !int(s.rebirth || 0, 0, 100)) return "보유량";
    if (!int(s.hpPot || 0, 0, 99) || !int(s.mpPot || 0, 0, 99) || !int(s.prot || 0, 0, 9999) || !int(s.statReset || 0, 0, 9999)) return "보유량";
  }
  if (prev && !dev) {
    if (s.lvl - prev.lvl > 25 + mins * 3) return "레벨 급상승";
    if ((s.maxFloor || 0) - (prev.maxFloor || 0) > 10 + mins) return "층 급상승";
    if ((s.gold || 0) - (prev.gold || 0) > 1e8 * (mins + 1)) return "골드 급상승";
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
  ensureServerCharacter(acc) {
    if (acc.serverCharacter || !acc.save) return false;
    const snapshot = createServerCharacter(acc.save);
    if (!snapshot) return false;
    acc.serverCharacter = snapshot;
    acc.serverCharacterMigratedAt = Date.now();
    return true;
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
    if (path === "/internal/pvp") {
      const pv = (await this.ctx.storage.get("pvp")) || {};
      const W = pv[b.w] || { r: 1000, w: 0, l: 0 }, L = pv[b.l] || { r: 1000, w: 0, l: 0 };
      const ew = 1 / (1 + Math.pow(10, (L.r - W.r) / 400)), k = 32;
      W.r = Math.round(W.r + k * (1 - ew)); L.r = Math.max(0, Math.round(L.r - k * (1 - ew))); W.w++; L.l++;
      const wa = await this.ctx.storage.get("u:" + b.w), la = await this.ctx.storage.get("u:" + b.l);
      W.n = (wa && wa.name) || b.w; L.n = (la && la.name) || b.l;
      pv[b.w] = W; pv[b.l] = L;
      await this.ctx.storage.put("pvp", pv);
      return json({ ok: 1 });
    }
    if (path === "/api/pvprank") {
      const pv = (await this.ctx.storage.get("pvp")) || {};
      return json({ ok: 1, list: Object.values(pv).sort((a, b) => b.r - a.r || b.w - a.w).slice(0, 50) });
    }
    if (path === "/api/rank") {
      const rk = (await this.ctx.storage.get("rank")) || {};
      const list = Object.values(rk).sort((a, b) => b.lv - a.lv || b.fl - a.fl || b.ud - a.ud).slice(0, 50);
      return json({ ok: 1, list });
    }
    if (path === "/internal/party-reward") {
      const u = String(b.u || ""), killId = String(b.killId || "");
      if (!/^[a-z0-9_]{2,12}$/.test(u) || killId.length < 16 || killId.length > 80) return json({ err: "invalid_internal_reward" }, 400);
      const seenKey = "party-reward:" + killId;
      const seen = await this.ctx.storage.get(seenKey);
      if (seen) return json({ ok: 1, duplicate: 1, fields: seen.fields, rewards: seen.rewards });
      const target = await this.ctx.storage.get("u:" + u);
      if (!target || !target.save) return json({ err: "character_required" }, 404);
      const granted = applyMonsterRewards(target.save, String(b.type || ""), num(b.floor, 1, 100), !!b.elite, b.zone === "underdeep" ? "underdeep" : "tower");
      if (granted.error) return json({ err: granted.error }, 400);
      target.save = granted.save;
      target.serverItemLedger = target.serverItemLedger || {};
      target.pendingServerItems = target.pendingServerItems || [];
      if (granted.rewards.itemAdded && granted.rewards.item) {
        const item = granted.rewards.item;
        const id = Math.max(SERVER_ITEM_ID_BASE, target.serverItemNextId || SERVER_ITEM_ID_BASE);
        item.id = id;
        target.serverItemNextId = id + 1;
        target.serverItemLedger[String(id)] = serverItemRecord(item);
        target.pendingServerItems.push(JSON.parse(JSON.stringify(item)));
      }
      target.serverCharacter = createServerCharacter(target.save);
      target.serverRewardFields = rewardFields(target.save);
      target.serverProgress = target.serverProgress || { xp: 0, kills: 0 };
      target.serverProgress.xp = Math.min(2_000_000_000, (target.serverProgress.xp || 0) + (granted.rewards.xp || 0));
      target.serverProgress.kills = Math.min(2_000_000_000, (target.serverProgress.kills || 0) + 1);
      const fields = rewardSyncFields(target.save);
      const rewards = granted.rewards;
      await this.ctx.storage.put("u:" + u, target);
      await this.ctx.storage.put(seenKey, { fields, rewards });
      return json({ ok: 1, fields, rewards, level: granted.level, xp: granted.xp, pts: granted.pts });
    }
    if (path === "/internal/underdeep-clear-reward") {
      const u = String(b.u || ""), room = num(b.room, 1, 20) | 0, runId = String(b.runId || "");
      if (!/^[a-z0-9_]{2,12}$/.test(u) || !/^[0-9a-f-]{36}$/.test(runId)) return json({ err: "invalid_underdeep_reward" }, 400);
      const target = await this.ctx.storage.get("u:" + u);
      if (!target || !target.save) return json({ err: "character_required" }, 404);
      target.underdeepClaims = target.underdeepClaims || {};
      const claimKey = room + ":" + runId;
      if (target.underdeepClaims[claimKey]) return json({ ok: 1, duplicate: 1, fields: rewardSyncFields(target.save), rewards: {} });
      const granted = applyUnderdeepClearRewards(target.save, room);
      if (granted.error) return json({ err: granted.error }, 400);
      target.save = granted.save;
      target.serverItemLedger = target.serverItemLedger || {};
      target.pendingServerItems = target.pendingServerItems || [];
      for (const item of granted.itemsAdded) {
        const id = Math.max(SERVER_ITEM_ID_BASE, target.serverItemNextId || SERVER_ITEM_ID_BASE);
        item.id = id;
        target.serverItemNextId = id + 1;
        target.serverItemLedger[String(id)] = serverItemRecord(item);
        target.pendingServerItems.push(JSON.parse(JSON.stringify(item)));
      }
      target.underdeepClaims[claimKey] = true;
      target.serverRewardFields = rewardFields(target.save);
      await this.ctx.storage.put("u:" + u, target);
      return json({ ok: 1, fields: rewardSyncFields(target.save), rewards: granted.rewards });
    }
    if (path === "/internal/chest-reward") {
      const u = String(b.u || ""), zone = b.zone === "underdeep" ? "underdeep" : "tower";
      const floor = num(b.floor, 1, 100) | 0, kind = String(b.kind || "");
      if (!/^[a-z0-9_]{2,12}$/.test(u) || !["wood", "iron", "gold"].includes(kind)) return json({ err: "invalid_chest_reward" }, 400);
      const target = await this.ctx.storage.get("u:" + u);
      if (!target || !target.save) return json({ err: "character_required" }, 404);
      target.chestClaims = target.chestClaims || {};
      const runId = String(b.runId || "");
      if (!/^[0-9a-f-]{36}$/.test(runId)) return json({ err: "invalid_chest_run" }, 400);
      const claimKey = zone + ":" + floor + ":" + runId;
      if (target.chestClaims[claimKey]) return json({ err: "already_claimed" }, 409);
      const granted = applyChestRewards(target.save, kind, floor, zone);
      if (granted.error) return json({ err: granted.error }, 400);
      target.save = granted.save;
      target.serverItemLedger = target.serverItemLedger || {};
      target.pendingServerItems = target.pendingServerItems || [];
      for (const item of granted.itemsAdded) {
        const id = Math.max(SERVER_ITEM_ID_BASE, target.serverItemNextId || SERVER_ITEM_ID_BASE);
        item.id = id;
        target.serverItemNextId = id + 1;
        target.serverItemLedger[String(id)] = serverItemRecord(item);
        target.pendingServerItems.push(JSON.parse(JSON.stringify(item)));
      }
      target.chestClaims[claimKey] = true;
      target.serverRewardFields = rewardFields(target.save);
      await this.ctx.storage.put("u:" + u, target);
      return json({ ok: 1, fields: rewardSyncFields(target.save), rewards: granted.rewards });
    }
    if (path === "/api/whoami") {
      const acc = await this.session(b.token);
      if (!acc) return json({});
      if (this.ensureServerCharacter(acc)) await this.ctx.storage.put("u:" + acc.u, acc);
      return json({ u: acc.u, name: acc.name || acc.u, blinkCooldownMs: acc.serverCharacter ? blinkCooldownMs(acc.serverCharacter) : 2500, combatDamage: acc.serverCharacter ? serverAttackPower(acc.serverCharacter) : 1, combatLevel: acc.serverCharacter ? acc.serverCharacter.lvl : 1 });
    }
    const acc = await this.session(b.token);
    if (!acc) return json({ err: "session" }, 401);
    if (path === "/api/movement/blink") {
      if (this.ensureServerCharacter(acc)) await this.ctx.storage.put("u:" + acc.u, acc);
      if (!acc.serverCharacter) return json({ err: "character_required" }, 409);
      const resolved = resolveBlink(acc.serverCharacter, acc.movement || {}, Date.now());
      if (resolved.error) return json({ err: resolved.error, cooldownMs: resolved.cooldownMs, remainingMs: resolved.remainingMs }, 429);
      acc.movement = resolved.state;
      await this.ctx.storage.put("u:" + acc.u, acc);
      return json({ ok: 1, movement: acc.movement, result: resolved.result });
    }
    if (path === "/api/combat/state") {
      return json({ ok: 1, combat: acc.combat || null });
    }
    if (path === "/api/combat/start") {
      if (this.ensureServerCharacter(acc)) await this.ctx.storage.put("u:" + acc.u, acc);
      if (!acc.serverCharacter) return json({ err: "character_required" }, 409);
      const started = startEncounter(acc.serverCharacter, String(b.encounter || ""), Date.now());
      if (started.error) return json({ err: started.error }, 400);
      acc.combat = started.state;
      await this.ctx.storage.put("u:" + acc.u, acc);
      return json({ ok: 1, combat: acc.combat });
    }
    if (path === "/api/combat/attack") {
      if (this.ensureServerCharacter(acc)) await this.ctx.storage.put("u:" + acc.u, acc);
      if (!acc.serverCharacter || !acc.combat) return json({ err: "no_active_encounter" }, 409);
      const resolved = resolveAttack(acc.serverCharacter, acc.combat, Date.now());
      if (resolved.error) return json({ err: resolved.error }, resolved.error === "cooldown" ? 429 : 409);
      acc.combat = resolved.state;
      // 처치 보상은 서버 상태에만 누적한다. 승리 상태는 재공격할 수 없어 중복 지급되지 않는다.
      if (resolved.result.rewards && resolved.result.rewards.xp > 0) {
        acc.serverProgress = acc.serverProgress || { xp: 0, kills: 0 };
        acc.serverProgress.xp = Math.min(2_000_000_000, (acc.serverProgress.xp || 0) + resolved.result.rewards.xp);
        acc.serverProgress.kills = Math.min(2_000_000_000, (acc.serverProgress.kills || 0) + 1);
      }
      await this.ctx.storage.put("u:" + acc.u, acc);
      return json({ ok: 1, combat: acc.combat, result: resolved.result, serverProgress: acc.serverProgress || { xp: 0, kills: 0 } });
    }
    if (path === "/api/stats/allocate") {
      if (!acc.save) return json({ err: "character_required" }, 409);
      const allocated = allocateServerStat(acc.save, String(b.stat || ""));
      if (allocated.error) return json({ err: allocated.error }, 400);
      acc.save = allocated.save;
      acc.serverCharacter = createServerCharacter(acc.save);
      acc.serverRewardFields = rewardFields(acc.save);
      await this.ctx.storage.put("u:" + acc.u, acc);
      return json({ ok: 1, stat: allocated.stat, pts: allocated.pts, st: acc.save.st });
    }
    if (path === "/api/load") {
      if (this.ensureServerCharacter(acc)) await this.ctx.storage.put("u:" + acc.u, acc);
      return json({ ok: 1, u: acc.u, name: acc.name || acc.u, dev: dev(acc.u), save: acc.save || null, serverCharacterReady: !!acc.serverCharacter });
    }
    if (path === "/api/logout") {
      await this.ctx.storage.delete("tok:" + acc.tok); acc.tok = null;
      await this.ctx.storage.put("u:" + acc.u, acc);
      return json({ ok: 1 });
    }
    if (path === "/api/save") {
      const incoming = b.save, why = checkSave(incoming, acc.save, dev(acc.u), (Date.now() - (acc.saved || 0)) / 60000);
      if (why) return json({ err: "bad", why }, 400);
      const s = { ...incoming, inv: [...(incoming.inv || [])] };
      // 보상/스탯 API가 서버에서 확정한 필드는 브라우저 저장으로 되돌릴 수 없다.
      if (acc.serverRewardFields) Object.assign(s, rewardFields(acc.serverRewardFields));
      const ownershipError = validateServerItemOwnership(s, acc);
      if (ownershipError) return json({ err: "bad", why: ownershipError }, 400);
      const currentIds = new Set(listedItems(s).map((item) => String(item.id)));
      const pending = acc.pendingServerItems || [];
      for (const item of pending) {
        if (!currentIds.has(String(item.id))) return json({ err: "loot_sync_pending" }, 409);
      }
      for (const [id, record] of Object.entries(acc.serverItemLedger || {})) {
        if (record.active && !currentIds.has(id)) record.active = false;
      }
      acc.pendingServerItems = [];
      if (!acc.save && s.pid) {
        // 이 기기 캐릭터를 처음 올릴 때: 같은 캐릭터를 두 계정에 복사하지 못하게 막는다
        const owner = await this.ctx.storage.get("pid:" + s.pid);
        if (owner && owner !== acc.u) return json({ err: "bad", why: "이미 다른 계정에 있는 캐릭터예요" }, 409);
        await this.ctx.storage.put("pid:" + s.pid, acc.u);
      }
      acc.save = s; acc.saved = Date.now();
      acc.serverItemLedger = acc.serverItemLedger || {};
      // New characters get a first snapshot; an existing snapshot is never replaced by browser saves.
      if (!acc.serverCharacter) {
        acc.serverCharacter = createServerCharacter(s);
        if (acc.serverCharacter) acc.serverCharacterMigratedAt = Date.now();
      }
      await this.ctx.storage.put("u:" + acc.u, acc);
      const rk = (await this.ctx.storage.get("rank")) || {};
      const prevR = rk[acc.u], row = { n: acc.name || acc.u, lv: s.lvl | 0, fl: s.maxFloor | 0, ud: s.underdeepBestRoom | 0, el: String((s.aff || [])[0] || ""), job: String(s.job || ""), c: s.circle | 0 };
      if (!prevR || prevR.lv !== row.lv || prevR.fl !== row.fl || prevR.ud !== row.ud || prevR.job !== row.job || prevR.n !== row.n) { rk[acc.u] = row; await this.ctx.storage.put("rank", rk); }
      return json({ ok: 1 });
    }
    if (path === "/api/delchar") {
      acc.save = null;
      acc.serverCharacter = null;
      acc.serverCharacterMigratedAt = null;
      acc.serverItemLedger = {};
      acc.pendingServerItems = [];
      acc.serverItemNextId = SERVER_ITEM_ID_BASE;
      acc.combat = null;
      acc.movement = null;
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
