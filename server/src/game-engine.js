// 서버가 몬스터 체력·공격 간격·처치 경험치를 소유한다.
import { MONSTERS } from "./monsters.js";
const TRAINING_DUMMY = Object.freeze({ name: "훈련용 허수아비", maxHp: 5000, defense: 0, xp: 0, attackCooldownMs: 700 });
function encounterSpec(id) {
  if (id === "training_dummy") return TRAINING_DUMMY;
  const monster = MONSTERS[id];
  if (!monster) return null;
  return { name: monster.n, maxHp: Math.max(1, Math.floor(monster.hp)), defense: 0, xp: Math.max(0, Math.floor(monster.xp || 0)), boss: !!monster.boss, attackCooldownMs: 700 };
}

const clampInt = (v, min, max) => Number.isFinite(v) ? Math.max(min, Math.min(max, Math.floor(v))) : min;

// Import a bounded legacy snapshot once; later browser saves cannot overwrite it.
export function createServerCharacter(save) {
  if (!save || !Number.isInteger(save.lvl) || save.lvl < 1 || save.lvl > 200) return null;
  const st = save.st && typeof save.st === "object" ? save.st : {};
  const eq = save.eq && typeof save.eq === "object" ? save.eq : {};
  const cleanEq = {};
  for (const [slot, item] of Object.entries(eq)) {
    if (!item || typeof item !== "object") continue;
    cleanEq[slot] = {
      v: clampInt(item.v || 0, 0, 10000),
      il: clampInt(item.il || 1, 1, 200),
      my: typeof item.my === "string" ? item.my.slice(0, 32) : undefined,
      a: item.a && typeof item.a === "object"
        ? Object.fromEntries(Object.entries(item.a).slice(0, 24).map(([k, v]) => [String(k).slice(0, 24), clampInt(v, -10000, 10000)]))
        : {},
    };
  }
  return {
    lvl: clampInt(save.lvl, 1, 200),
    hp: clampInt(save.hp || 100, 1, 1000000),
    mhp: clampInt(save.mhp || save.hp || 100, 1, 1000000),
    st: { int: clampInt(st.int || 0, 0, 10000), wis: clampInt(st.wis || 0, 0, 10000) },
    eq: cleanEq,
    circle: clampInt(save.circle || 1, 1, 9),
    blinkLv: clampInt(save.blinkLv || 0, 0, 100),
    job: typeof save.job === "string" ? save.job.slice(0, 16) : "",
  };
}

// Party relay damage is derived from the immutable server character snapshot.
export function serverAttackPower(save) {
  const stats = save && save.st || {};
  const level = clampInt(save && save.lvl, 1, 200);
  const intelligence = clampInt(stats.int || 0, 0, 10000);
  const weapon = save && save.eq && save.eq.staff;
  const weaponPower = weapon ? clampInt(weapon.v || 0, 0, 10000) + clampInt(weapon.il || 1, 1, 200) : 0;
  return Math.max(1, level * 2 + intelligence * 3 + weaponPower);
}

// Sanitize party hit targets and replace every client-provided damage value.
export function sanitizePartyHits(rows, power, maxTargets = 8) {
  if (!Array.isArray(rows)) return [];
  const damage = clampInt(power, 1, 100000);
  const limit = clampInt(maxTargets, 1, 8);
  const seen = new Set(), hits = [];
  for (const row of rows.slice(0, 32)) {
    if (!Array.isArray(row) || row.length < 1) continue;
    const id = Number(row[0]);
    if (!Number.isSafeInteger(id) || id < 1 || id > 10000000 || seen.has(id)) continue;
    seen.add(id);
    hits.push([id, damage]);
    if (hits.length >= limit) break;
  }
  return hits;
}

// Validate the party leader's visual combat snapshot before it is relayed.
export function sanitizePartySnapshot(snapshot, zone, floor) {
  if (!snapshot || typeof snapshot !== "object" || snapshot.z !== zone || snapshot.fl !== floor) return null;
  if (!["tower", "underdeep"].includes(zone)) return null;
  const enemies = [];
  for (const row of (Array.isArray(snapshot.e) ? snapshot.e : []).slice(0, 80)) {
    if (!Array.isArray(row) || row.length < 8) continue;
    const [rawId, rawType, rawX, rawY, rawHp, rawFace, rawElite, rawFrozen] = row;
    const id = Number(rawId), type = String(rawType);
    if (!Number.isSafeInteger(id) || id < 1 || id > 10000000 || !MONSTERS[type]) continue;
    const x = Number(rawX), y = Number(rawY), hp = Number(rawHp);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(hp)) continue;
    enemies.push([id, type, Math.max(0, Math.min(4000, Math.round(x))), Math.max(0, Math.min(4000, Math.round(y))), Math.max(0, Math.min(1000, Math.round(hp))), Number(rawFace) < 0 ? -1 : 1, rawElite ? 1 : 0, rawFrozen ? 1 : 0]);
  }
  const bullets = [];
  for (const row of (Array.isArray(snapshot.b) ? snapshot.b : []).slice(0, 110)) {
    if (!Array.isArray(row) || row.length < 8) continue;
    const [rx, ry, rvx, rvy, rr, rawColor, rdmg, rboss] = row;
    const values = [rx, ry, rvx, rvy, rr, rdmg].map(Number);
    if (!values.every(Number.isFinite)) continue;
    const [x, y, vx, vy, radius, damage] = values;
    const color = /^#[0-9a-f]{3,8}$/i.test(String(rawColor)) ? String(rawColor) : "#ffffff";
    bullets.push([Math.max(0, Math.min(4000, Math.round(x))), Math.max(0, Math.min(4000, Math.round(y))), Math.max(-2000, Math.min(2000, Math.round(vx))), Math.max(-2000, Math.min(2000, Math.round(vy))), Math.max(1, Math.min(30, radius)), color, Math.max(0, Math.min(50000, Math.round(damage))), rboss ? 1 : 0]);
  }
  const kills = (Array.isArray(snapshot.kd) ? snapshot.kd : []).slice(0, 80).map(Number).filter((id) => Number.isSafeInteger(id) && id > 0 && id <= 10000000);
  return { k: "s", z: zone, fl: floor, e: enemies, b: bullets, cl: snapshot.cl ? 1 : 0, kd: kills };
}

const PARTY_HPM = [[1,1.7],[15,1.77],[25,1.98],[30,2.27],[35,2.73],[40,3.46],[50,4.6],[60,4.96],[75,5.43],[90,6.3],[100,7.0]];
function partyCurve(table, floor) {
  for (let i = 1; i < table.length; i++) {
    if (floor <= table[i][0]) {
      const a = table[i - 1], b = table[i], t = (floor - a[0]) / (b[0] - a[0]);
      return a[1] + (b[1] - a[1]) * t;
    }
  }
  return table[table.length - 1][1];
}

export function partyMonsterXp(type, floor, elite = false, zone = "tower") {
  const monster = MONSTERS[type];
  if (!monster) return 0;
  const f = zone === "underdeep" ? Math.min(100, 90 + Math.max(1, floor)) : Math.max(1, Math.min(100, floor));
  return Math.max(0, Math.round((monster.xp || 0) * (1 + 0.2 * (f - 1)) * (elite ? 5 : 1)));
}

export function partyMonsterMaxHp(type, floor, level, elite, partySize, zone = "tower") {
  const monster = MONSTERS[type];
  if (!monster) return 0;
  const f = zone === "underdeep" ? Math.min(100, 90 + Math.max(1, floor)) : Math.max(1, Math.min(100, floor));
  const hpScale = (1 + 0.056 * Math.pow(f - 1, 2.2)) * partyCurve(PARTY_HPM, f);
  const levelThreat = 1 + Math.max(0, Math.min(200, level) - 99) * 0.005;
  const deepScale = zone === "underdeep" ? 1 + Math.max(0, floor - 10) * 0.05 : 1;
  const eliteScale = elite ? 6 : 1;
  let bossScale = 1;
  if (monster.boss) {
    const bossLate = 1 + Math.max(0, f - 20) * 0.035;
    bossScale = (1.9 + f / 26) * 2.4 * bossLate;
    bossScale *= 0.5 * (1 + 0.8 * (Math.max(1, Math.min(4, partySize)) - 1));
    if (monster.final) {
      const finalBossScale = 2.4 * (1 + Math.max(0, 100 - 20) * 0.035);
      bossScale *= 12 / finalBossScale;
    }
  }
  return Math.max(1, Math.round(monster.hp * hpScale * levelThreat * eliteScale * bossScale * deepScale));
}

export function createPartyHealthState(snapshot, previous, options, now = Date.now()) {
  const { zone, floor, level, partySize } = options;
  const sameRun = previous && previous.zone === zone && previous.floor === floor;
  const enemies = sameRun ? { ...(previous.enemies || {}) } : {};
  const seen = new Set();
  for (const row of snapshot.e || []) {
    const [id, type, x, y, , face, elite, frozen] = row;
    seen.add(id);
    const old = enemies[id];
    if (old && old.type === type && old.hp > 0) {
      enemies[id] = { ...old, x, y, face, elite: !!elite, frozen: !!frozen, lastSeenAt: now };
    } else if (!old) {
      const maxHp = partyMonsterMaxHp(type, floor, level, !!elite, partySize, zone);
      if (maxHp) enemies[id] = { id, type, x, y, face, elite: !!elite, frozen: !!frozen, hp: maxHp, maxHp, dead: false, lastSeenAt: now };
    }
  }
  for (const [id, enemy] of Object.entries(enemies)) {
    if (!seen.has(Number(id)) && now - (enemy.lastSeenAt || now) > 3000) delete enemies[id];
  }
  return { zone, floor, enemies };
}

export function applyPartyHits(state, hits) {
  const enemies = { ...(state && state.enemies || {}) };
  const results = [], kills = [];
  for (const [id, requestedDamage] of hits || []) {
    const enemy = enemies[id];
    if (!enemy || enemy.dead || enemy.hp <= 0) continue;
    const damage = Math.max(1, clampInt(requestedDamage, 1, 100000));
    const applied = enemy.type && MONSTERS[enemy.type] && MONSTERS[enemy.type].boss
      ? Math.min(damage, Math.max(1, Math.floor(enemy.maxHp * 0.08)))
      : damage;
    const hp = Math.max(0, enemy.hp - applied);
    const dead = hp <= 0;
    enemies[id] = { ...enemy, hp, dead };
    results.push({ id: Number(id), type: enemy.type, x: enemy.x, y: enemy.y, face: enemy.face, elite: enemy.elite, frozen: enemy.frozen, hp, maxHp: enemy.maxHp, xp: partyMonsterXp(enemy.type, state.floor, enemy.elite, state.zone), dead });
    if (dead) kills.push(Number(id));
  }
  return { state: { ...state, enemies }, results, kills };
}

export function partyHealthRecords(state) {
  return Object.values(state && state.enemies || {}).map((enemy) => ({
    id: enemy.id, type: enemy.type, x: enemy.x, y: enemy.y, face: enemy.face,
    elite: enemy.elite, frozen: enemy.frozen, hp: enemy.hp, maxHp: enemy.maxHp, xp: partyMonsterXp(enemy.type, state.floor, enemy.elite, state.zone), dead: !!enemy.dead,
  }));
}

export function partyHealthRows(state) {
  return Object.values(state && state.enemies || {}).map((enemy) => [
    enemy.id, enemy.type, enemy.x, enemy.y,
    Math.max(0, Math.min(1000, Math.round(enemy.hp / enemy.maxHp * 1000))),
    enemy.face, enemy.elite ? 1 : 0, enemy.frozen ? 1 : 0,
  ]);
}

export function startEncounter(save, encounterId, now = Date.now()) {
  const spec = encounterSpec(encounterId);
  if (!spec) return { error: "encounter_not_allowed" };
  if (!save || !Number.isInteger(save.lvl) || save.lvl < 1 || save.lvl > 200) return { error: "invalid_character" };
  return {
    state: {
      id: crypto.randomUUID(),
      encounterId,
      monsterName: spec.name,
      monsterBoss: !!spec.boss,
      rewardXp: spec.xp,
      monsterHp: spec.maxHp,
      monsterMaxHp: spec.maxHp,
      startedAt: now,
      lastAttackAt: 0,
      playerHp: clampInt(save.hp || 100, 1, 1_000_000),
      playerMaxHp: clampInt(save.mhp || save.hp || 100, 1, 1_000_000),
      turns: 0,
      status: "active",
    },
  };
}

export function resolveAttack(save, combat, now = Date.now()) {
  if (!combat || combat.status !== "active") return { error: "no_active_encounter" };
  const spec = encounterSpec(combat.encounterId);
  if (!spec) return { error: "invalid_encounter" };
  if (now - combat.lastAttackAt < spec.attackCooldownMs) return { error: "cooldown" };

  // 공격력은 클라이언트 입력을 받지 않고 서버에 저장된 캐릭터 능력치에서 계산한다.
  const baseDamage = serverAttackPower(save);
  const damage = Math.max(1, baseDamage - spec.defense);
  const monsterHp = Math.max(0, combat.monsterHp - damage);
  const next = {
    ...combat,
    monsterHp,
    lastAttackAt: now,
    turns: combat.turns + 1,
    status: monsterHp === 0 ? "won" : "active",
  };
  const rewards = monsterHp === 0 ? { xp: Math.max(0, Math.floor(combat.rewardXp || 0)) } : null;
  return { state: next, result: { damage, monsterHp, monsterMaxHp: combat.monsterMaxHp, status: next.status, rewards } };
}


// 서버가 마지막 순간이동 시각을 소유한다. 브라우저의 p.bcd 값은 판정에 사용하지 않는다.
export function blinkCooldownMs(save) {
  const s = save || {};
  const stats = s.st || {};
  const charLevel = clampInt(s.lvl || 1, 1, 200);
  const pointScale = charLevel < 60 ? 1 : charLevel < 90 ? 1 + 0.2 * (charLevel - 59) / 30 : charLevel < 120 ? 1.2 - 0.2 * (charLevel - 90) / 30 : 1;
  const gearWisdom = Object.values(s.eq || {}).reduce((sum, item) => sum + clampInt(item && item.a && item.a.wis || 0, 0, 10000), 0);
  const wisdom = clampInt(stats.wis || 0, 0, 10000) * pointScale + gearWisdom;
  const circle = clampInt(s.circle || 1, 1, 9);
  const cdr = Math.min(0.5, wisdom * 0.01 + (circle >= 9 ? 0.15 : 0));
  const level = clampInt(s.blinkLv || 0, 0, 100);
  const job = s.job === "wind" ? 0.5 : 1;
  const shoes = s.eq && s.eq.shoes;
  const stride = shoes && shoes.my === "uqStride" ? 0.65 : 1;
  const baseCooldown = level <= 10 ? 2500 * (1 - 0.035 * level) : 1625 - (level - 10) * (1225 / 90);
  return Math.round(baseCooldown * (1 - cdr * 0.5) * job * stride);
}

export function resolveBlink(save, movement = {}, now = Date.now()) {
  if (!save || !Number.isInteger(save.lvl)) return { error: "character_required" };
  const cooldownMs = blinkCooldownMs(save);
  const lastBlinkAt = clampInt(movement.lastBlinkAt || 0, 0, Number.MAX_SAFE_INTEGER);
  const remainingMs = Math.max(0, cooldownMs - (now - lastBlinkAt));
  if (remainingMs > 0) return { error: "cooldown", cooldownMs, remainingMs, state: movement };
  return {
    state: { ...movement, lastBlinkAt: now },
    result: { accepted: true, cooldownMs, nextAvailableAt: now + cooldownMs },
  };
}
