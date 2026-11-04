import test from 'node:test';
import assert from 'node:assert/strict';
import { getCatalog, validateCatalog } from '../catalog.js';
import { addCard, applyCommand, advanceWorld, reconcile } from '../game.js';
import { createPersonalWorld, summarizeMaterials, takeGiftCards, receiveGiftCards } from '../personal-world.js';
import { applySimulationOperation, replaySimulationBatch } from '../local-simulation.js';

function fixture() {
  const world = createPersonalWorld({ id: 'chest-test', name: 'Kistentest' }, getCatalog(), 0);
  const chest = addCard(world, 'chest', 1100, 700);
  const add = (type, extra = {}) => addCard(world, type, 600, 400, extra);
  const get = (id) => world.cards.find((card) => card.id === id);
  const command = (value, now = 0) => applyCommand(world, value, { playerId: world.id, now, rng: () => 0 });
  const store = (card, extra = {}) => command({ type: 'store', cardId: chest.id, itemId: card.id, split: true, takeAbove: false, ...extra });
  const stack = (types) => {
    const cards = types.map((type) => add(type));
    cards.forEach((card, order) => Object.assign(card, { stackId: cards[0].id, order, x: cards[0].x, y: cards[0].y }));
    return cards;
  };
  return { world, chest, add, get, command, store, stack };
}

test('ten wood craft a chest after ten seconds without requiring or consuming a human', () => {
  const f = fixture();
  f.world.cards = f.world.cards.filter((card) => card.type === 'human');
  const woods = f.stack(Array(10).fill('wood'));
  reconcile(f.world, 0);
  assert.equal(f.world.jobs.length, 1);
  assert.equal(f.world.jobs[0].recipeId, 'chest');
  advanceWorld(f.world, 9999);
  assert.ok(woods.every((card) => f.get(card.id)));
  advanceWorld(f.world, 10000);
  assert.ok(woods.every((card) => !f.get(card.id)));
  assert.equal(f.world.cards.filter((card) => card.type === 'human').length, 1);
  assert.deepEqual(f.world.cards.find((card) => card.type === 'chest').contents, []);
});

test('storage removes resource cards from the table, preserves their state and includes them in material counts', () => {
  const f = fixture(), wood = f.add('wood', { customState: 'preserved' });
  const before = summarizeMaterials(f.world);
  f.store(wood);
  assert.equal(f.get(wood.id), undefined);
  assert.equal(f.get(f.chest.id).contents[0].id, wood.id);
  assert.equal(f.get(f.chest.id).contents[0].customState, 'preserved');
  assert.deepEqual(summarizeMaterials(f.world), before);
  assert.equal(f.world.jobs.some((job) => job.cardIds.includes(wood.id)), false);
});

test('dropping on a chest stores the grabbed card and every card above and tidies the remaining stack', () => {
  const f = fixture(), [bottom, middle, top] = f.stack(['wood', 'stone', 'berry']);
  f.command({ type: 'move', cardId: middle.id, targetId: f.chest.id, takeAbove: true, x: 1100, y: 700 });
  assert.deepEqual(f.get(f.chest.id).contents.map((card) => card.id), [middle.id, top.id]);
  assert.equal(f.get(bottom.id).order, 0);
  assert.equal(f.get(middle.id), undefined);
  assert.equal(f.get(top.id), undefined);
});

test('mixed forbidden stacks reject atomically instead of partially storing resources', () => {
  for (const type of ['human', 'cow', 'rat', 'tree', 'axe', 'pack', 'chest']) {
    const f = fixture(), cards = f.stack(['wood', type]);
    const before = structuredClone(f.world);
    assert.throws(() => f.store(cards[0], { split: false, takeAbove: true }), /Ressourcen und Essen/);
    assert.deepEqual(f.world, before);
  }
});

test('humans and other non-resource selections still stack normally on a chest', () => {
  const f = fixture(), human = f.world.cards.find((card) => card.type === 'human');
  const wood = f.add('wood');
  f.command({ type: 'move', cardId: human.id, targetId: f.chest.id, split: true, x: 1100, y: 700 });
  assert.equal(f.get(human.id).stackId, f.get(f.chest.id).stackId);
  assert.equal(f.get(human.id).order, 1);
  assert.deepEqual(f.get(f.chest.id).contents, []);
  f.command({ type: 'move', cardId: wood.id, targetId: human.id, split: true, x: 1100, y: 700 });
  assert.equal(f.get(wood.id).stackId, f.get(human.id).stackId);
  assert.equal(f.get(wood.id).order, 2);
  const other = f.add('chest');
  f.command({ type: 'move', cardId: human.id, targetId: other.id, takeAbove: true, x: other.x, y: other.y });
  assert.equal(f.get(human.id).stackId, f.get(other.id).stackId);
  assert.equal(f.get(wood.id).stackId, f.get(other.id).stackId);
  assert.deepEqual(f.get(other.id).contents, []);
});

test('a filled chest stacks on another chest without nesting or losing its contents', () => {
  const f = fixture(), wood = f.add('wood'), other = f.add('chest');
  f.store(wood);
  f.command({ type: 'move', cardId: f.chest.id, targetId: other.id, split: true, x: other.x, y: other.y });
  assert.equal(f.get(f.chest.id).stackId, f.get(other.id).stackId);
  assert.equal(f.get(f.chest.id).order, 1);
  assert.deepEqual(f.get(other.id).contents, []);
  assert.deepEqual(f.get(f.chest.id).contents.map((card) => card.id), [wood.id]);
  assert.equal(f.get(wood.id), undefined);
  const before = structuredClone(f.world);
  assert.throws(() => f.command({ type: 'store', cardId: other.id, itemId: f.chest.id, split: true }), /Ressourcen und Essen/);
  assert.deepEqual(f.world, before);
});

test('retrieve returns exactly the selected original card and guards missing IDs and invalid selectors', () => {
  const f = fixture(), [one, two] = f.stack(['berry', 'berry']);
  f.store(one, { takeAbove: true });
  const nextId = f.world.nextId;
  f.command({ type: 'retrieve', cardId: f.chest.id, itemId: one.id, x: 100, y: 300 });
  assert.equal(f.get(one.id).x, 100);
  assert.equal(f.get(one.id).y, 300);
  assert.equal(f.get(one.id).stackId, one.id);
  assert.equal(f.world.nextId, nextId);
  assert.deepEqual(f.get(f.chest.id).contents.map((card) => card.id), [two.id]);
  for (const command of [
    { type: 'retrieve', cardId: f.chest.id, itemId: one.id },
    { type: 'retrieve', cardId: f.chest.id, itemId: two.id, allOfType: 'yes' },
    { type: 'store', cardId: f.chest.id, itemId: one.id, split: 'yes' },
    { type: 'store', cardId: f.chest.id, itemId: one.id, takeAbove: 1 },
  ]) {
    const before = structuredClone(f.world);
    assert.throws(() => f.command(command));
    assert.deepEqual(f.world, before);
  }
});

test('retrieve all takes only that resource type and creates one movable stack', () => {
  const f = fixture(), [one, other, two] = f.stack(['stone', 'berry', 'stone']);
  f.store(one, { takeAbove: true });
  f.command({ type: 'retrieve', cardId: f.chest.id, itemId: two.id, allOfType: true });
  assert.deepEqual(f.get(f.chest.id).contents.map((card) => card.id), [other.id]);
  assert.equal(f.get(one.id).stackId, f.get(two.id).stackId);
  assert.deepEqual([f.get(one.id).order, f.get(two.id).order], [0, 1]);
  assert.equal(f.get(one.id).x, f.get(two.id).x);
});

test('filled chests cannot be sold, gifted or consumed by a recipe; empty chests can be gifted', () => {
  const f = fixture(), wood = f.add('wood');
  f.store(wood);
  const before = structuredClone(f.world);
  assert.throws(() => f.command({ type: 'move', cardId: f.chest.id, zone: 'sell', split: true, x: 100, y: 300 }), /geleert/);
  assert.throws(() => takeGiftCards(f.world, { cardId: f.chest.id }), /Leere die Kiste/);
  assert.deepEqual(f.world, before);
  f.world.catalog.recipes.push({ id: 'consumeChest', name: 'Kiste zerlegen', ingredients: { chest: 1 }, duration: 1000, result: 'wood', resultCount: 1, requiresHuman: false, timeBase: 'world' });
  reconcile(f.world, 0);
  advanceWorld(f.world, 2000);
  assert.equal(f.world.jobs.length, 0);
  assert.equal(f.get(f.chest.id).contents[0].id, wood.id);
  f.command({ type: 'retrieve', cardId: f.chest.id, itemId: wood.id }, 2000);
  f.world.catalog.recipes = f.world.catalog.recipes.filter((recipe) => recipe.id !== 'consumeChest');
  reconcile(f.world, 2000);
  const gifts = takeGiftCards(f.world, { cardId: f.chest.id }, 2000);
  const other = createPersonalWorld({ id: 'other', name: 'Andere Welt' }, getCatalog(), 2000);
  const [receivedId] = receiveGiftCards(other, gifts, 2000);
  assert.deepEqual(other.cards.find((card) => card.id === receivedId).contents, []);
  const otherBefore = structuredClone(other);
  assert.throws(() => receiveGiftCards(other, [{ ...gifts[0], contents: [{ id: 'hidden', type: 'wood' }] }], 2000), /Leere die Kiste/);
  assert.deepEqual(other, otherBefore);
});

test('a loaded craft cannot destroy a chest filled since its job was created', () => {
  const f = fixture(), wood = f.add('wood');
  f.world.catalog.recipes.push({ id: 'consumeChest', name: 'Kiste zerlegen', ingredients: { chest: 1 }, duration: 1000, result: 'wood', resultCount: 1, requiresHuman: false, timeBase: 'world' });
  reconcile(f.world, 0);
  assert.equal(f.world.jobs[0].recipeId, 'consumeChest');
  f.get(f.chest.id).contents.push({ ...wood });
  f.world.cards = f.world.cards.filter((card) => card.id !== wood.id);
  advanceWorld(f.world, 2000);
  assert.equal(f.get(f.chest.id).contents[0].id, wood.id);
});

test('catalog deletion and category changes cannot strand stored custom resources', () => {
  const f = fixture();
  f.world.catalog.cardTypes.test_resource = { ...f.world.catalog.cardTypes.wood, name: 'Testressource' };
  const card = f.add('test_resource'); f.store(card);
  const deleted = structuredClone(f.world.catalog); delete deleted.cardTypes.test_resource;
  assert.throws(() => validateCatalog(deleted, f.world), /Kiste/);
  const edited = structuredClone(f.world.catalog); edited.cardTypes.test_resource.category = 'building';
  assert.throws(() => validateCatalog(edited, f.world), /Kiste/);
  assert.equal(f.get(f.chest.id).contents[0].type, 'test_resource');
});

test('version-three catalogs gain the chest without restoring intentionally deleted content or replacing edits', () => {
  const catalog = structuredClone(getCatalog()); catalog.contentVersion = 3;
  delete catalog.cardTypes.chest; catalog.recipes = catalog.recipes.filter((recipe) => recipe.id !== 'chest');
  delete catalog.cardTypes.cookedMeat; catalog.recipes = catalog.recipes.filter((recipe) => recipe.id !== 'cookMeat');
  catalog.cardTypes.knife.effects = []; catalog.packs[0].price = 9;
  const before = structuredClone(catalog), upgraded = getCatalog({ catalog });
  assert.deepEqual(catalog, before);
  assert.equal(upgraded.contentVersion, 5);
  assert.equal(upgraded.cardTypes.chest.name, 'Kiste');
  assert.deepEqual(upgraded.recipes.find((recipe) => recipe.id === 'chest').ingredients, { wood: 10 });
  assert.equal(upgraded.cardTypes.cookedMeat, undefined);
  assert.deepEqual(upgraded.cardTypes.knife.effects, []);
  assert.equal(upgraded.packs[0].price, 9);
  const custom = structuredClone(before);
  custom.recipes.push({ id: 'customChest', name: 'Holzkiste', ingredients: { wood: 10 }, duration: 20000, result: 'warehouse', resultCount: 1, requiresHuman: true, timeBase: 'world' });
  assert.equal(getCatalog({ catalog: custom }).recipes.some((recipe) => recipe.id === 'chest'), false);
});

test('browser storage and retrieval replay identically after a save and JSON restart', () => {
  const f = fixture(), wood = f.add('wood'), base = structuredClone(f.world);
  const operations = [
    { kind: 'command', at: 1, activeUntil: 1, command: { type: 'store', cardId: f.chest.id, itemId: wood.id, split: true } },
    { kind: 'command', at: 2, activeUntil: 2, command: { type: 'retrieve', cardId: f.chest.id, itemId: wood.id, x: 100, y: 300 } },
  ];
  for (const op of operations) applySimulationOperation(f.world, op);
  const server = JSON.parse(JSON.stringify(base)); replaySimulationBatch(server, operations, { maxTime: 2 });
  assert.deepEqual(server, f.world);
  assert.equal(server.cards.find((card) => card.id === wood.id).x, 100);
  assert.deepEqual(server.cards.find((card) => card.type === 'chest').contents, []);
});
