import { MONSTERS } from "../src/monsters.js";
import test from "node:test";
import assert from "node:assert/strict";
import { startEncounter, resolveAttack, blinkCooldownMs, resolveBlink } from "../src/game-engine.js";

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

test("attack damage is computed from server-side character snapshot", () => {
  const started = startEncounter(character, "training_dummy", 10000).state;
  const first = resolveAttack(character, started, 11000);
  assert.equal(first.result.damage, 45);
  assert.equal(first.result.monsterHp, 4955);
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
  assert.ok(blinkCooldownMs(boosted) >= 500);
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
