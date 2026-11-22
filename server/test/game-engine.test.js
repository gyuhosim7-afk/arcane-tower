import { MONSTERS } from "../src/monsters.js";
import test from "node:test";
import assert from "node:assert/strict";
import { startEncounter, resolveAttack, blinkCooldownMs, resolveBlink, createServerCharacter, serverAttackPower, sanitizePartyHits, sanitizePartySnapshot, partyMonsterMaxHp, partyMonsterXp, createPartyHealthState, applyPartyHits, partyHealthRows, partyHealthRecords, applyChestRewards, applyUnderdeepClearRewards, applyServerXp, xpRequired, allocateServerStat, rollMonsterRewards, applyMonsterRewards } from "../src/game-engine.js";

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
  assert.equal(serverAttackPower(saved), 87);
});

test("party hit sanitizer ignores client damage, duplicates, and invalid target IDs", () => {
  const rows = [[4, 999999999], [4, 1], [0, 500], [-1, 500], ["bad", 500], [9, 0], [10, 123]];
  assert.deepEqual(sanitizePartyHits(rows, 45), [[4, 45], [9, 45], [10, 45]]);
  assert.deepEqual(sanitizePartyHits(rows, 45, 2), [[4, 45], [9, 45]]);
  assert.deepEqual(sanitizePartyHits("not-an-array", 45), []);
});

test("party snapshot sanitizer rejects spoofed zones and bounds enemy and projectile data", () => {
  assert.equal(sanitizePartySnapshot({ z: "town", fl: 1 }, "tower", 1), null);
  const safe = sanitizePartySnapshot({
    z: "tower", fl: 4,
    e: [[1, "slime", 99999, -10, 1500, 0, 1, 0], [2, "unknown", 1, 1, 1000, 1, 0, 0]],
    b: [[99999, -5, 99999, -99999, 99, "not-a-color", 999999, 1]],
    kd: [1, 2, "bad"], cl: true,
  }, "tower", 4);
  assert.deepEqual(safe.e, [[1, "slime", 4000, 0, 1000, 1, 1, 0]]);
  assert.deepEqual(safe.b, [[4000, 0, 2000, -2000, 30, "#ffffff", 50000, 1]]);
  assert.deepEqual(safe.kd, [1, 2]);
});

test("party monster HP is initialized from server catalog and floor scaling", () => {
  const solo = partyMonsterMaxHp("kingslime", 1, 10, false, 1, "tower");
  const duo = partyMonsterMaxHp("kingslime", 1, 10, false, 2, "tower");
  const trio = partyMonsterMaxHp("kingslime", 1, 10, false, 3, "tower");
  assert.ok(solo > 0);
  assert.ok(duo > solo);
  assert.ok(trio > duo);
  assert.equal(partyMonsterMaxHp("not-a-monster", 1, 10, false, 2), 0);
});

test("party monster XP is calculated from the server catalog and floor", () => {
  assert.equal(partyMonsterXp("slime", 1), 5);
  assert.equal(partyMonsterXp("slime", 10), 14);
  assert.equal(partyMonsterXp("slime", 10, true), 70);
  assert.equal(partyMonsterXp("unknown", 10), 0);
});

test("party health state ignores client HP ratios and server applies bounded damage", () => {
  const snapshot = { e: [[7, "slime", 100, 200, 1, 1, 0, 0]] };
  const state = createPartyHealthState(snapshot, null, { zone: "tower", floor: 1, level: 10, partySize: 2 }, 1000);
  const enemy = state.enemies[7];
  assert.equal(enemy.hp, enemy.maxHp);
  const hit = applyPartyHits(state, [[7, 45]]);
  assert.equal(hit.results[0].hp, Math.max(0, enemy.maxHp - 45));
  assert.deepEqual(partyHealthRows(hit.state)[0].slice(0, 2), [7, "slime"]);
});

test("party boss damage is capped per hit and duplicate kills are blocked", () => {
  const snapshot = { e: [[8, "kingslime", 100, 200, 1000, 1, 0, 0]] };
  const state = createPartyHealthState(snapshot, null, { zone: "tower", floor: 1, level: 10, partySize: 2 }, 1000);
  const one = applyPartyHits(state, [[8, 100000]]);
  assert.ok(one.results[0].hp >= state.enemies[8].maxHp * 0.91);
  let current = one.state, killed = false;
  for (let i = 0; i < 20; i++) {
    const next = applyPartyHits(current, [[8, 100000]]);
    if (!next.results.length) break;
    current = next.state;
    killed = next.results[0].dead;
    if (killed) break;
  }
  assert.equal(killed, true);
  assert.deepEqual(applyPartyHits(current, [[8, 100000]]).results, []);
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
  assert.deepEqual(snapshot.st, { int: 4, vit: 0, crit: 0, wis: 8 });
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

test("server XP uses the game's level curve and grants three points per level", () => {
  const save = { ...character, lvl: 1, xp: 0, pts: 0, st: { int: 0, vit: 0, crit: 0, wis: 0 } };
  const result = applyServerXp(save, xpRequired(1));
  assert.equal(result.level, 2);
  assert.equal(result.xp, 0);
  assert.equal(result.pts, 3);
  const multi = applyServerXp(save, xpRequired(1) + xpRequired(2));
  assert.equal(multi.level, 3);
  assert.equal(multi.pts, 6);
});

test("server stat allocation spends exactly one available point", () => {
  const save = { ...character, pts: 2, st: { int: 0, vit: 0, crit: 0, wis: 0 } };
  const result = allocateServerStat(save, "vit");
  assert.equal(result.pts, 1);
  assert.equal(result.save.st.vit, 1);
  assert.equal(allocateServerStat({ ...save, pts: 0 }, "int").error, "no_points");
  assert.equal(allocateServerStat(save, "gold").error, "invalid_stat");
});

test("server monster loot follows catalog drop rules and produces valid base equipment", () => {
  const normal = rollMonsterRewards("slime", 1, false, "tower", () => 0.99);
  assert.equal(normal.gold, 0);
  assert.equal(normal.ess, 0);
  assert.equal(normal.item, null);
  const elite = rollMonsterRewards("slime", 10, true, "tower", () => 0.99);
  assert.ok(elite.gold > 0);
  assert.ok(elite.ess > 0);
  assert.ok(elite.ore > 0);
  assert.ok(elite.item);
  assert.ok(["staff", "robe", "ring"].includes(elite.item.slot));
  assert.ok(elite.item.r >= 0 && elite.item.r <= 4);
  const boss = rollMonsterRewards("kingslime", 1, false, "tower", () => 0.99);
  assert.ok(boss.gold > 0 && boss.ess > 0 && boss.ore > 0);
  assert.equal(boss.epotScroll, 1);
});

test("server monster rewards persist XP, currency, and generated inventory items", () => {
  const save = { ...character, lvl: 1, xp: 0, pts: 0, gold: 0, ess: 0, ore: 0, inv: [], uid: 10 };
  const result = applyMonsterRewards(save, "slime", 10, true, "tower", () => 0.99);
  assert.ok(result.save.gold > 0);
  assert.ok(result.save.ess > 0);
  assert.ok(result.save.ore > 0);
  assert.equal(result.save.inv.length, 1);
  assert.equal(result.save.inv[0].id, 10);
  assert.equal(result.save.uid, 11);
  assert.equal(result.save.inv[0].up, 0);
});

test("server combat records omit dead enemies after returning confirmed kill IDs", () => {
  const snapshot = { e: [[12, "slime", 100, 200, 1000, 1, 0, 0]] };
  const state = createPartyHealthState(snapshot, null, { zone: "tower", floor: 1, level: 10, partySize: 1 }, 1000);
  const killed = applyPartyHits(state, [[12, 100000]]);
  assert.deepEqual(killed.kills, [12]);
  assert.equal(partyHealthRecords(killed.state).some((row) => row.id === 12), false);
});

test("server chest rewards create the correct currency, protection, and equipment payload", () => {
  const save = { ...character, gold: 0, ess: 0, ore: 0, hpPot: 0, mpPot: 0, prot: 0, inv: [], uid: 1, shoesUnlocked: false };
  const result = applyChestRewards(save, "gold", 5, "tower", () => 0.99);
  assert.ok(result.save.gold > 0);
  assert.equal(result.save.ess, 8);
  assert.equal(result.save.ore, 10);
  assert.equal(result.save.prot, 1);
  assert.equal(result.itemsAdded.length, 4);
  assert.equal(result.rewards.itemAdded, 4);
  assert.ok(result.itemsAdded.every((item) => item.r >= 2));
});

test("server chest rewards auto-sell equipment when the bag is full", () => {
  const inv = Array.from({ length: 32 }, (_, i) => ({ id: i + 1, slot: "staff", r: 0, il: 1, up: 0, v: 0, a: {} }));
  const save = { ...character, gold: 0, ess: 0, ore: 0, hpPot: 0, mpPot: 0, prot: 0, inv, uid: 33 };
  const result = applyChestRewards(save, "wood", 1, "tower", () => 0.99);
  assert.equal(result.itemsAdded.length, 0);
  assert.ok(result.rewards.autoSold > 0);
  assert.equal(result.save.inv.length, 32);
  assert.ok(result.save.gold > result.rewards.gold);
});

test("server combat state records boss and elite kills for chest eligibility", () => {
  const snapshot = { e: [[31, "kingslime", 100, 200, 1000, 1, 0, 0], [32, "golem", 120, 210, 1000, 1, 1, 0]] };
  const state = createPartyHealthState(snapshot, null, { zone: "tower", floor: 5, level: 10, partySize: 1 }, 1000);
  assert.equal(state.seenEnemyCount, 2);
  const hits = Array.from({ length: 20 }, () => [31, 100000]).concat([[32, 100000]]);
  const result = applyPartyHits(state, hits);
  assert.equal(result.state.bossKilled, true);
  assert.equal(result.state.eliteKilled, true);
  assert.equal(result.state.killCount, 2);
});

test("server gold chests roll tower mythics and underdeep uniques", () => {
  const base = { ...character, lvl: 50, gold: 0, ess: 0, ore: 0, hpPot: 0, mpPot: 0, prot: 0, inv: [], uid: 1, shoesUnlocked: false };
  const tower = applyChestRewards(base, "gold", 10, "tower", () => 0);
  assert.equal(tower.rewards.myth, "slimeRing");
  assert.ok(tower.itemsAdded.some((item) => item.my === "slimeRing" && item.r === 5));
  const deep = applyChestRewards(base, "gold", 5, "underdeep", () => 0);
  assert.equal(deep.rewards.myth, "uqSeal");
  assert.ok(deep.itemsAdded.some((item) => item.my === "uqSeal" && item.r === 6));
  assert.ok(deep.itemsAdded.some((item) => item.r === 4 && !item.my));
  assert.ok(deep.itemsAdded.some((item) => item.r >= 3 && !item.my));
  assert.equal(deep.itemsAdded.find((item) => item.my === "uqSeal").a.cdr, undefined);
});

test("underdeep room completion rewards are server-calculated, including boss gear and uniques", () => {
  const base = { ...character, lvl: 50, gold: 0, ess: 0, ore: 0, inv: [], uid: 1, shoesUnlocked: false };
  const normal = applyUnderdeepClearRewards(base, 1, () => 0.99);
  assert.equal(normal.save.gold, 21500);
  assert.equal(normal.save.ess, 25);
  assert.equal(normal.save.ore, 15);
  assert.equal(normal.save.underdeepBestRoom, 1);
  assert.equal(normal.itemsAdded.length, 0);
  const boss = applyUnderdeepClearRewards(base, 5, () => 0);
  assert.equal(boss.save.gold, 47500);
  assert.equal(boss.save.ess, 45);
  assert.equal(boss.save.ore, 27);
  assert.equal(boss.itemsAdded.length, 3);
  assert.equal(boss.rewards.myth, "uqSeal");
  assert.ok(boss.itemsAdded.some((item) => item.r === 4 && !item.my));
  assert.ok(boss.itemsAdded.some((item) => item.r === 3 && !item.my));
  assert.ok(boss.itemsAdded.some((item) => item.my === "uqSeal"));
});
