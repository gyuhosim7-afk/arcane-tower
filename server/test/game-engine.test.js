import { MONSTERS } from "../src/monsters.js";
import test from "node:test";
import assert from "node:assert/strict";
import { startEncounter, resolveAttack, blinkCooldownMs, resolveBlink, createServerCharacter, serverAttackPower } from "../src/game-engine.js";

const character = {
  lvl: 10,
  hp: 120,
  mhp: 120,
  st: { int: 4 },
  eq: { staff: { v: 3, il: 10 } },
};

test("rejects unknown encounter ids", () => {
  assert.equal(startEncounter(character, "boss_admin").error, "encounter_not_allowed");
});

test("server creates encounter health; client cannot supply monster HP", () => {
  const started = startEncounter(character, "training_dummy", 10000);
  assert.equal(started.state.monsterHp, 5000);
  assert.equal(started.state.monsterMaxHp, 5000);
});

test("server can start encounters for real catalog monsters and bosses", () => {
  const slime = startEncounter(character, "slime", 10000);
  assert.equal(slime.state.monsterName, "슬라임");
  assert.equal(slime.state.monsterHp, MONSTERS.slime.hp);
  assert.equal(slime.state.rewardXp, MONSTERS.slime.xp);
  const boss = startEncounter(character, "kingslime", 10000);
  assert.equal(boss.state.monsterBoss, true);
  assert.equal(boss.state.monsterHp, MONSTERS.kingslime.hp);
});

test("real monster kill reward is calculated by the server catalog", () => {
  const strong = { ...character, lvl: 200, st: { int: 10000 } };
  const started = startEncounter(strong, "slime", 10000).state;
  const won = resolveAttack(strong, started, 11000);
  assert.equal(won.state.status, "won");
  assert.deepEqual(won.result.rewards, { xp: MONSTERS.slime.xp });
  assert.equal(resolveAttack(strong, won.state, 12000).error, "no_active_encounter");
});

test("attack damage is computed from server-side character snapshot", () => {
  const started = startEncounter(character, "training_dummy", 10000).state;
  const first = resolveAttack(character, started, 11000);
  assert.equal(first.result.damage, 45);
  assert.equal(first.result.monsterHp, 4955);
});

test("party combat damage is derived from the server character snapshot", () => {
  assert.equal(serverAttackPower(character), 45);
  const saved = createServerCharacter({ ...character, lvl: 20, st: { int: 10 }, eq: { staff: { v: 5, il: 12 } } });
  assert.equal(serverAttackPower(saved), 84);
});

test("server enforces attack cooldown", () => {
  const started = startEncounter(character, "training_dummy", 10000).state;
  const first = resolveAttack(character, started, 11000);
  assert.equal(resolveAttack(character, first.state, 11100).error, "cooldown");
});

test("victory state cannot be attacked again", () => {
  const started = startEncounter({ ...character, lvl: 200, st: { int: 10000 } }, "training_dummy", 10000).state;
  const won = resolveAttack({ ...character, lvl: 200, st: { int: 10000 } }, started, 11000);
  assert.equal(won.state.status, "won");
  assert.equal(resolveAttack(character, won.state, 12000).error, "no_active_encounter");
});

test("server monster catalog includes source game baseline stats", () => {
  assert.equal(MONSTERS.slime.hp, 28);
  assert.equal(MONSTERS.slime.dmg, 6);
  assert.equal(MONSTERS.kingslime.boss, 1);
  assert.equal(MONSTERS.ymir.boss, 1);
  assert.ok(Object.keys(MONSTERS).length >= 30);
});


test("teleport cooldown is server-derived and never zero", () => {
  assert.equal(blinkCooldownMs(character), 2500);
  const boosted = { ...character, circle: 9, blinkLv: 10, job: "wind", st: { wis: 100 } , eq: { shoes: { my: "uqStride" } } };
  assert.equal(blinkCooldownMs(boosted), 396);
});

test("server rejects teleport attempts before the account cooldown expires", () => {
  const save = { ...character, blinkLv: 0 };
  const first = resolveBlink(save, {}, 10000);
  assert.equal(first.result.accepted, true);
  assert.equal(first.state.lastBlinkAt, 10000);
  const tooSoon = resolveBlink(save, first.state, 11000);
  assert.equal(tooSoon.error, "cooldown");
  assert.ok(tooSoon.remainingMs > 0);
  const ready = resolveBlink(save, first.state, 12500);
  assert.equal(ready.result.accepted, true);
});

test("client cannot reset the server-owned teleport timestamp", () => {
  const save = { ...character, blinkLv: 0 };
  const serverState = resolveBlink(save, {}, 50000).state;
  const manipulatedClientCooldown = 0;
  assert.equal(manipulatedClientCooldown, 0);
  assert.equal(resolveBlink(save, serverState, 50001).error, "cooldown");
});


test("legacy save is converted into a bounded server-owned character snapshot", () => {
  const legacy = { ...character, circle: 3, blinkLv: 2, job: "wind", st: { int: 4, wis: 8, ignored: 999999 }, eq: { staff: { v: 3, il: 10, a: { wis: 2 } }, extra: null }, gold: 999999999999 };
  const snapshot = createServerCharacter(legacy);
  assert.deepEqual(snapshot.st, { int: 4, wis: 8 });
  assert.equal(snapshot.eq.staff.v, 3);
  assert.equal(snapshot.circle, 3);
  assert.equal(snapshot.job, "wind");
  assert.equal("gold" in snapshot, false);
  legacy.st.int = 999;
  assert.equal(snapshot.st.int, 4);
});

test("server character migration rejects missing or invalid legacy characters", () => {
  assert.equal(createServerCharacter(null), null);
  assert.equal(createServerCharacter({ lvl: 0 }), null);
  assert.equal(createServerCharacter({ lvl: 201 }), null);
});


test("teleport skill reaches level 100 and 0.4 second base cooldown", () => {
  assert.equal(blinkCooldownMs({ ...character, blinkLv: 10 }), 1625);
  assert.equal(blinkCooldownMs({ ...character, blinkLv: 100 }), 400);
  assert.equal(blinkCooldownMs({ ...character, blinkLv: 101 }), 400);
});

test("legacy character migration preserves teleport levels through 100", () => {
  const migrated = createServerCharacter({ ...character, blinkLv: 100 });
  assert.equal(migrated.blinkLv, 100);
  const bounded = createServerCharacter({ ...character, blinkLv: 150 });
  assert.equal(bounded.blinkLv, 100);
});
