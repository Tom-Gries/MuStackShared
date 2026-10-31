import test from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG, getCatalog, validateCatalog } from '../catalog.js';
import { addCard, applyCommand, advanceWorld, reconcile } from '../game.js';
import { createPersonalWorld, ensurePersonalCatalog, receiveGiftCards, summarizeMaterials, takeGiftCards } from '../personal-world.js';

const make = (id = 'alice', now = 1000) => createPersonalWorld({ id, name: id === 'alice' ? '  Alice  ' : id }, getCatalog(), now);
const human = (world) => world.cards.find((card) => card.type === 'human');
const add = (world, type, extra = {}) => addCard(world, type, 1100, 300, extra);
function stack(world, types) {
  const cards = types.map((type) => add(world, type));
  for (const [order, card] of cards.entries()) Object.assign(card, { stackId: cards[0].id, order, x: cards[0].x, y: cards[0].y });
  return cards;
}

test('fresh personal worlds have precisely their own human, starting gold and independent catalog', () => {
  const catalog = structuredClone(getCatalog());
  catalog.packs[0].name = 'Unser Paket';
  const world = createPersonalWorld({ id: 'account-123', name: '  Alice   Test ' }, catalog, 4321);
  assert.equal(world.id, 'account-123');
  assert.equal(world.clock.lastAt, 4321);
  assert.equal(world.cards.filter((card) => card.type === 'human').length, 1);
  assert.equal(world.cards.filter((card) => card.type === 'gold').length, CONFIG.startingGold);
  assert.equal(world.cards.length, CONFIG.startingGold + 1);
  assert.deepEqual(world.players, [{ id: 'account-123', name: 'Alice Test', nameKey: 'alice test', joinedAt: 4321, cardId: human(world).id }]);
  assert.equal(human(world).ownerId, 'account-123');
  assert.equal(human(world).hp, CONFIG.humanHp);
  assert.deepEqual(world.jobs, []);
  assert.deepEqual(world.combats, []);
  assert.equal(world.catalog.packs[0].name, 'Unser Paket');
  world.catalog.packs[0].name = 'Geändert';
  assert.equal(catalog.packs[0].name, 'Unser Paket');
  const second = make('bob');
  assert.equal(human(second).ownerId, 'bob');
  assert.equal(second.cards.length, CONFIG.startingGold + 1);
  assert.throws(() => make(''), /Spieler-ID/);
  assert.throws(() => createPersonalWorld({ id: 'id', name: '' }), /Name/);
});

test('material summaries include every non-human type and gold inside piggy banks', () => {
  const world = make();
  add(world, 'piggyBank', { gold: 12 });
  add(world, 'piggyBank', { gold: 5 });
  stack(world, ['wood', 'wood', 'berry']);
  add(world, 'pack');
  add(world, 'rabbit', { hp: 1 });
  add(world, 'corpse');
  assert.deepEqual(summarizeMaterials(world), [
    { type: 'berry', count: 1 }, { type: 'gold', count: CONFIG.startingGold + 17 },
    { type: 'pack', count: 1 }, { type: 'piggyBank', count: 2 }, { type: 'rabbit', count: 1 }, { type: 'wood', count: 2 },
  ]);
});

test('gifting a middle card takes it and all cards above while tidying the remaining stack', () => {
  const world = make();
  const cards = stack(world, ['wood', 'stone', 'berry', 'stick']);
  world.cards.reverse();
  const gifts = takeGiftCards(world, { cardId: cards[1].id }, 2000);
  assert.deepEqual(new Set(gifts.map((card) => card.id)), new Set(cards.slice(1).map((card) => card.id)));
  assert.ok(cards.slice(1).every((card) => !world.cards.some((entry) => entry.id === card.id)));
  assert.equal(world.cards.find((card) => card.id === cards[0].id).order, 0);
  assert.equal(human(world).ownerId, 'alice');
});

test('explicit single-card splitting and whole-stack selections match dragging', () => {
  const world = make();
  const cards = stack(world, ['wood', 'stone', 'berry']);
  assert.deepEqual(takeGiftCards(world, { cardId: cards[1].id, split: true, takeAbove: false }).map((card) => card.type), ['stone']);
  assert.deepEqual(takeGiftCards(world, { cardId: cards[2].id, split: false, takeAbove: false }).map((card) => card.type), ['wood', 'berry']);
});

test('any forbidden card rejects the complete selection without moving or consuming anything', () => {
  for (const type of ['human', 'corpse', 'rat']) {
    const world = make();
    const cards = stack(world, ['wood', type]);
    const before = structuredClone(world);
    assert.throws(() => takeGiftCards(world, { cardId: cards[0].id }), { status: 400 });
    assert.deepEqual(world, before);
  }
});

test('equipped tools cannot be gifted independently or carried through a human selection', () => {
  const world = make();
  const tool = add(world, 'axe', { equippedTo: human(world).id, stackId: human(world).stackId });
  human(world).toolId = tool.id;
  const before = structuredClone(world);
  assert.throws(() => takeGiftCards(world, { cardId: tool.id }), /Werkzeug/);
  assert.throws(() => takeGiftCards(world, { cardId: human(world).id }), /Menschen|Werkzeug/);
  assert.deepEqual(world, before);
});

test('active source work, growing recipes and combat participants cannot leave their worlds', () => {
  const sourceWorld = make();
  const tree = add(sourceWorld, 'tree');
  applyCommand(sourceWorld, { type: 'move', cardId: human(sourceWorld).id, targetId: tree.id, x: tree.x, y: tree.y }, { playerId: 'alice', now: 1000 });
  const growing = make();
  const ingredients = stack(growing, ['soil', 'berry']);
  growing.jobs.push({ id: 'j-test', kind: 'grow', cardIds: ingredients.map((card) => card.id) });
  const fighting = make();
  const chicken = add(fighting, 'chicken');
  fighting.combats.push({ id: 'b-test', humanIds: [human(fighting).id], ratIds: [chicken.id] });
  for (const [world, cardId] of [[sourceWorld, tree.id], [growing, ingredients[0].id], [fighting, chicken.id]]) {
    const before = structuredClone(world);
    assert.throws(() => takeGiftCards(world, { cardId, takeAbove: false }), /laufenden Arbeit|Kampf/);
    assert.deepEqual(world, before);
  }
});

test('gifts retain source uses, bank coins, purchased-pack contents, animal health and field deadline', () => {
  const sender = make();
  const receiver = make('bob', 100_000);
  const source = add(sender, 'tree', { remaining: 2, outputFromId: 'old-anchor', sourceOutputId: 'old-source' });
  const bank = add(sender, 'piggyBank', { gold: 17 });
  const pack = add(sender, 'pack', { packId: 'retired-pack', packName: 'Altes Paket', packColor: '#abcdef', packSize: 4,
    packContents: [{ type: 'wood', weight: 7 }, { type: 'rat', weight: 1 }], cardsLeft: 2 });
  const field = add(sender, 'field', { readyAt: 86_401_000 });
  const rabbit = add(sender, 'rabbit', { hp: 1, motion: { behavior: 'wander', fromX: 0, fromY: 0, toX: 400, toY: 300, duration: 1000, startedAt: 0 } });
  const expected = [source, bank, pack, field, rabbit].map((card) => ({ ...card }));
  const gifts = [source, bank, pack, field, rabbit].flatMap((card) => takeGiftCards(sender, { cardId: card.id }, 2000));
  const giftBefore = structuredClone(gifts);
  const ids = receiveGiftCards(receiver, gifts, 100_000);
  assert.deepEqual(gifts, giftBefore);
  assert.equal(new Set(ids).size, gifts.length);
  assert.ok(ids.every((id) => !gifts.some((card) => card.id === id)));
  const received = ids.map((id) => receiver.cards.find((card) => card.id === id));
  assert.equal(received[0].remaining, 2);
  assert.equal(received[1].gold, 17);
  for (const key of ['packId', 'packName', 'packColor', 'packSize', 'packContents', 'cardsLeft']) assert.deepEqual(received[2][key], expected[2][key]);
  assert.equal(received[3].readyAt, 86_401_000);
  assert.equal(received[4].hp, 1);
  assert.equal(received[0].outputFromId, undefined);
  assert.equal(received[0].sourceOutputId, undefined);
  assert.ok(!received[4].motion || received[4].motion.startedAt === receiver.clock.elapsed);
  assert.deepEqual(sender.jobs, []);
  assert.deepEqual(receiver.jobs, []);
  assert.equal(summarizeMaterials(receiver).find((item) => item.type === 'gold').count, CONFIG.startingGold + 17);
});

test('received stacks get new IDs, relative order and a free position beside the recipient', () => {
  const sender = make();
  const receiver = make('bob');
  const items = stack(sender, ['wood', 'stone', 'berry']);
  const gift = takeGiftCards(sender, { cardId: items[0].id });
  gift.reverse();
  const oldCards = structuredClone(receiver.cards);
  const ids = receiveGiftCards(receiver, gift);
  const received = ids.map((id) => receiver.cards.find((card) => card.id === id));
  assert.equal(new Set(received.map((card) => card.stackId)).size, 1);
  assert.equal(received[0].stackId, received.find((card) => card.order === 0).id);
  assert.deepEqual([...received].sort((a, b) => a.order - b.order).map((card) => card.type), ['wood', 'stone', 'berry']);
  assert.ok(received.every((card) => card.x === received[0].x && card.y === received[0].y));
  assert.ok(oldCards.every((card) => card.x !== received[0].x || card.y !== received[0].y));
  assert.equal(new Set(receiver.cards.map((card) => card.id)).size, receiver.cards.length);
  assert.ok(Math.abs(received[0].x - human(receiver).x) < 650);
});

test('malformed, duplicate, unknown and forbidden incoming cards roll back the entire delivery', () => {
  for (const invalid of [
    { id: 'bad', type: 'unknown', stackId: 's', order: 0 },
    { id: 'bad', type: 'rat', stackId: 's', order: 0, hp: 2 },
    { id: 'bad', type: 'human', stackId: 's', order: 0 },
    { id: 'bad', type: 'axe', stackId: 's', order: 0, equippedTo: 'someone' },
    { id: 'bad', type: 'piggyBank', stackId: 's', order: 0, gold: -1 },
    { id: 'bad', type: 'pack', stackId: 's', order: 0, packContents: [{ type: 'missing', weight: 1 }] },
    { id: 'good', type: 'wood', stackId: 's', order: 1 },
  ]) {
    const world = make();
    const before = structuredClone(world);
    assert.throws(() => receiveGiftCards(world, [{ id: 'good', type: 'wood', stackId: 's', order: 0 }, invalid]), { status: 400 });
    assert.deepEqual(world, before);
  }
});

test('sender IDs may equal recipient equipment IDs without referring to that equipment', () => {
  const receiver = make('bob');
  const tool = add(receiver, 'axe', { equippedTo: human(receiver).id });
  human(receiver).toolId = tool.id;
  const ids = receiveGiftCards(receiver, [{ id: tool.id, type: 'wood', stackId: tool.id, order: 0 }]);
  assert.notEqual(ids[0], tool.id);
  assert.equal(receiver.cards.find((card) => card.id === ids[0]).type, 'wood');
  assert.equal(human(receiver).toolId, tool.id);
});

test('the town hall is a valid building with an existing illustration and an exact 100-stone recipe', () => {
  const catalog = structuredClone(getCatalog());
  assert.equal(catalog.cardTypes.town_hall.category, 'building');
  assert.equal(catalog.cardTypes.town_hall.art, 'warehouse');
  assert.deepEqual(catalog.recipes.find((recipe) => recipe.id === 'town_hall'), {
    id: 'town_hall', name: 'Rathaus', ingredients: { stone: 100 }, duration: 60_000,
    result: 'town_hall', resultCount: 1, requiresHuman: true, timeBase: 'world',
  });
  assert.doesNotThrow(() => validateCatalog(catalog, make()));
});

test('100 stones and a human build one town hall after a minute; stones alone never start construction', () => {
  const world = make();
  const first = add(world, 'stone');
  for (let index = 1; index < 99; index++) addCard(world, 'stone', first.x, first.y, { stackId: first.id, order: index });
  reconcile(world, 1000);
  assert.equal(world.jobs.length, 0);
  addCard(world, 'stone', first.x, first.y, { stackId: first.id, order: 99 });
  reconcile(world, 1000);
  assert.equal(world.jobs.length, 0);
  const workerId = human(world).id;
  applyCommand(world, { type: 'move', cardId: workerId, targetId: first.id, x: first.x, y: first.y, split: true, takeAbove: false }, { playerId: 'alice', now: 1000 });
  assert.equal(world.jobs.length, 1);
  assert.equal(world.jobs[0].recipeId, 'town_hall');
  assert.equal(world.jobs[0].humanId, workerId);
  assert.equal(world.jobs[0].cardIds.length, 101);
  advanceWorld(world, 60_999);
  assert.equal(world.cards.some((card) => card.type === 'town_hall'), false);
  advanceWorld(world, 61_000);
  assert.equal(world.cards.filter((card) => card.type === 'town_hall').length, 1);
  assert.equal(world.cards.filter((card) => card.type === 'stone').length, 0);
  assert.equal(human(world).id, workerId);
  assert.equal(world.jobs.length, 0);
});

test('canonical catalog migration adds town-hall content once and preserves custom definitions', () => {
  const old = structuredClone(getCatalog());
  delete old.cardTypes.town_hall;
  old.recipes = old.recipes.filter((recipe) => recipe.id !== 'town_hall');
  old.cardTypes.wood.name = 'Bauholz';
  const before = structuredClone(old);
  const migrated = ensurePersonalCatalog(old);
  assert.deepEqual(old, before);
  assert.equal(migrated.cardTypes.town_hall.name, 'Rathaus');
  assert.equal(migrated.cardTypes.wood.name, 'Bauholz');
  assert.equal(migrated.recipes.filter((recipe) => recipe.id === 'town_hall').length, 1);
  assert.deepEqual(ensurePersonalCatalog(migrated), migrated);
  migrated.cardTypes.town_hall.name = 'Gemeindehaus';
  migrated.recipes.find((recipe) => recipe.id === 'town_hall').duration = 80_000;
  assert.deepEqual(ensurePersonalCatalog(migrated), migrated);
});
