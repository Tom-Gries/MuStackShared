import test from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG, getCatalog } from '../catalog.js';
import { addCard, applyCommand, advanceWorld, advancePersonalWorld, reconcile } from '../game.js';
import { createPersonalWorld } from '../personal-world.js';

const make = () => createPersonalWorld({ id: 'alice', name: 'Alice' }, getCatalog(), 0);
const human = (world) => world.cards.find((card) => card.type === 'human');
const card = (world, id) => world.cards.find((entry) => entry.id === id);
const count = (world, type) => world.cards.filter((entry) => entry.type === type).length;
function move(world, cardId, targetId) {
  applyCommand(world, { type: 'move', cardId, targetId, x: 1000, y: 500, split: true, takeAbove: true }, { playerId: 'alice', now: 0 });
}
function source(world, type = 'tree', extra = {}) {
  const result = addCard(world, type, 1000, 500, extra);
  move(world, human(world).id, result.id);
  return result;
}

test('returning after a minute exhausts an unattended tree and awards exactly its five yields', () => {
  const world = make(), tree = source(world);
  advancePersonalWorld(world, 60_000, { activeUntil: 0, rng: () => 0 });
  assert.equal(card(world, tree.id), undefined);
  assert.equal(count(world, 'wood'), 5);
  assert.equal(world.jobs.length, 0);
  assert.equal(world.clock.lastAt, 60_000);
  assert.equal(world.clock.elapsed, 60_000);
  advancePersonalWorld(world, 60_000, { activeUntil: 0, rng: () => 0 });
  advancePersonalWorld(world, 86400000, { activeUntil: 0, rng: () => 0 });
  assert.equal(count(world, 'wood'), 5);
});

test('partial offline work keeps its remaining source uses and exact next completion time', () => {
  const world = make(), tree = source(world);
  advancePersonalWorld(world, 25_000, { activeUntil: 0, rng: () => 0.9 });
  assert.equal(count(world, 'stick'), 2);
  assert.equal(card(world, tree.id).remaining, 3);
  assert.equal(world.jobs[0].startedAt, 20_000);
  assert.equal(world.jobs[0].dueAt, 30_000);
  advancePersonalWorld(world, 29_999, { activeUntil: 25_000, rng: () => 0.9 });
  assert.equal(count(world, 'stick'), 2);
  advancePersonalWorld(world, 30_000, { rng: () => 0.9 });
  assert.equal(count(world, 'stick'), 3);
});

test('offline work continues through a mixed queue of trees, rocks and berry bushes', () => {
  const world = make(), tree = source(world);
  const rock = addCard(world, 'rock', tree.x, tree.y, { stackId: tree.stackId, order: 2 });
  const bush = addCard(world, 'berryBush', tree.x, tree.y, { stackId: tree.stackId, order: 3 });
  reconcile(world, 0);
  advancePersonalWorld(world, 120_000, { activeUntil: 0, rng: () => 0 });
  assert.equal(card(world, tree.id), undefined);
  assert.equal(card(world, rock.id), undefined);
  assert.equal(card(world, bush.id).remaining, 3);
  assert.equal(count(world, 'wood'), 5);
  assert.equal(count(world, 'stone'), 5);
  assert.equal(count(world, 'berry'), 2);
  advancePersonalWorld(world, 150_000, { activeUntil: 120_000, rng: () => 0 });
  assert.equal(card(world, bush.id), undefined);
  assert.equal(count(world, 'berry'), 5);
});

test('equipped tools still accelerate offline work and craft jobs finish without consuming the human', () => {
  const world = make(), worker = human(world);
  const axe = addCard(world, 'axe', 700, 500);
  move(world, axe.id, worker.id);
  const tree = source(world);
  assert.equal(world.jobs[0].duration, 5_000);
  advancePersonalWorld(world, 20_000, { activeUntil: 0, rng: () => 0 });
  assert.equal(card(world, tree.id).remaining, 1);
  assert.equal(count(world, 'wood'), 4);
  advancePersonalWorld(world, 25_000, { activeUntil: 20_000, rng: () => 0 });
  assert.equal(count(world, 'wood'), 5);
  assert.equal(human(world).toolId, axe.id);

  const build = make(), builder = human(build);
  const stones = Array.from({ length: 100 }, (_, order) => addCard(build, 'stone', 1000, 500, { stackId: 'stones', order }));
  move(build, builder.id, stones[0].id);
  advancePersonalWorld(build, 60_000, { activeUntil: 0 });
  assert.equal(count(build, 'town_hall'), 1);
  assert.equal(count(build, 'stone'), 0);
  assert.equal(human(build).id, builder.id);
});

test('the active interval runs normally, then offline combat preserves its remaining attack delay', () => {
  const world = make(), worker = human(world);
  const rat = addCard(world, 'rat', worker.x + 10, worker.y, { stackId: 'rat-near-worker' });
  reconcile(world, 0);
  advanceWorld(world, 1000);
  const remaining = world.combats[0].nextAttackAt - world.clock.elapsed;
  advancePersonalWorld(world, 86400000, { activeUntil: 1000 });
  assert.equal(worker.hp, 75);
  assert.equal(card(world, rat.id).hp, 2);
  assert.equal(world.combats[0].nextAttackAt - world.clock.elapsed, remaining);
  advancePersonalWorld(world, 86400000 + remaining - 1);
  assert.equal(human(world).hp, 75);
  advancePersonalWorld(world, 86400000 + remaining, { rng: () => 0 });
  assert.equal(human(world).hp, 74);
  assert.equal(card(world, rat.id).hp, 1);
});

test('wandering creatures resume from their visible pause position with the same remaining travel time', () => {
  const world = make();
  const cow = addCard(world, 'cow', 1100, 700);
  reconcile(world, 0);
  assert.ok(cow.motion);
  advanceWorld(world, 1000);
  const motion = structuredClone(cow.motion), remaining = motion.startedAt + motion.duration - world.clock.elapsed;
  const fraction = (1000 - motion.startedAt) / motion.duration;
  const expected = { x: motion.fromX + (motion.toX - motion.fromX) * fraction, y: motion.fromY + (motion.toY - motion.fromY) * fraction };
  advancePersonalWorld(world, 86400000, { activeUntil: 1000 });
  assert.ok(Math.abs(card(world, cow.id).x - expected.x) < 0.001);
  assert.ok(Math.abs(card(world, cow.id).y - expected.y) < 0.001);
  assert.equal(card(world, cow.id).motion.duration, remaining);
  assert.equal(card(world, cow.id).motion.startedAt, world.clock.elapsed);
});

test('unattended real growth keeps its historical harvest timestamp and stores one harvest', () => {
  const world = make();
  const soil = addCard(world, 'soil', 1100, 500), berry = addCard(world, 'berry', 1300, 500);
  move(world, berry.id, soil.id);
  advancePersonalWorld(world, 10 * CONFIG.fieldHarvestInterval, { activeUntil: 0 });
  const field = world.cards.find((entry) => entry.type === 'field');
  assert.ok(field);
  assert.equal(field.readyAt, CONFIG.fieldGrowDuration + CONFIG.fieldHarvestInterval);
  assert.equal(count(world, 'berry'), 0);
  assert.equal(count(world, 'field'), 1);
});

test('a field created by unattended world-time crafting starts its harvest timer at completion, not return', () => {
  const world = make();
  const catalog = structuredClone(world.catalog);
  catalog.recipes.push({ id: 'field-from-wood', name: 'Feld bauen', ingredients: { wood: 1 }, requiresHuman: false, duration: 10_000, result: 'field', resultCount: 1, timeBase: 'world' });
  world.catalog = catalog;
  addCard(world, 'wood', 1100, 500);
  reconcile(world, 0);
  advancePersonalWorld(world, 86400000, { activeUntil: 0 });
  assert.equal(world.cards.find((entry) => entry.type === 'field').readyAt, 10_000 + CONFIG.fieldHarvestInterval);
});

test('historical world-time outputs also retain their creation time inside the last active lease', () => {
  const world = make();
  world.catalog = structuredClone(world.catalog);
  world.catalog.recipes.push({ id: 'field-from-wood', name: 'Feld bauen', ingredients: { wood: 1 }, requiresHuman: false, duration: 10_000, result: 'field', resultCount: 1, timeBase: 'world' });
  addCard(world, 'wood', 1100, 500);
  reconcile(world, 0);
  advancePersonalWorld(world, 86400000, { activeUntil: 65_000 });
  assert.equal(world.cards.find((entry) => entry.type === 'field').readyAt, 10_000 + CONFIG.fieldHarvestInterval);
});
