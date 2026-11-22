// 서버 권한 전투 엔진의 1차 이전 단계.
// 클라이언트는 행동만 요청하고, 피해량·몬스터 HP·공격 간격은 서버가 결정한다.
// 실제 필드/보스 데이터 이전 전까지는 검증용 훈련용 허수아비만 허용한다.
const ENCOUNTERS = Object.freeze({
  training_dummy: Object.freeze({ name: "훈련용 허수아비", maxHp: 5000, defense: 0, attackCooldownMs: 700 }),
});

const clampInt = (v, min, max) => Number.isFinite(v) ? Math.max(min, Math.min(max, Math.floor(v))) : min;

export function startEncounter(save, encounterId, now = Date.now()) {
  const spec = ENCOUNTERS[encounterId];
  if (!spec) return { error: "encounter_not_allowed" };
  if (!save || !Number.isInteger(save.lvl) || save.lvl < 1 || save.lvl > 200) return { error: "invalid_character" };
  return {
    state: {
      id: crypto.randomUUID(),
      encounterId,
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
  const spec = ENCOUNTERS[combat.encounterId];
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
  return { state: next, result: { damage, monsterHp, monsterMaxHp: combat.monsterMaxHp, status: next.status } };
}
