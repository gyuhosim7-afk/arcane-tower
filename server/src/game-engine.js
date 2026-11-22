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
    blinkLv: clampInt(save.blinkLv || 0, 0, 10),
    job: typeof save.job === "string" ? save.job.slice(0, 16) : "",
  };
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
  const stats = save.st || {};
  const level = clampInt(save.lvl, 1, 200);
  const intelligence = clampInt(stats.int || 0, 0, 10000);
  const weapon = save.eq && save.eq.staff;
  const weaponPower = weapon ? clampInt(weapon.v || 0, 0, 10000) + clampInt(weapon.il || 1, 1, 200) : 0;
  const baseDamage = Math.max(1, level * 2 + intelligence * 3 + weaponPower);
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
  const level = clampInt(s.blinkLv || 0, 0, 10);
  const job = s.job === "wind" ? 0.5 : 1;
  const shoes = s.eq && s.eq.shoes;
  const stride = shoes && shoes.my === "uqStride" ? 0.65 : 1;
  return Math.round(2500 * (1 - cdr * 0.5) * (1 - 0.035 * level) * job * stride);
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
