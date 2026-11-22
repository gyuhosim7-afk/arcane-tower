import test from "node:test";
import assert from "node:assert/strict";
import { startEncounter, resolveAttack } from "../src/game-engine.js";

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
  assert.equal(first.result.damage, 56);
  assert.equal(first.result.monsterHp, 4944);
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
