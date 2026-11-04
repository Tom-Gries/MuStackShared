import test from 'node:test';
import assert from 'node:assert/strict';
import { CARD_TYPES, DEFAULT_CATALOG, getCatalog, getCardTypes, getPacks, validateCatalog } from '../catalog.js';
import { addCard, applyCommand, advancePersonalWorld, advanceWorld, reconcile } from '../game.js';
import { creatureProfile } from '../creatures.js';
import { createPersonalWorld } from '../personal-world.js';

const miningTypes = ['ironVein', 'coalVein', 'clayPool', 'bat', 'ironOre', 'coal', 'clay'];
const clone = (value) => structuredClone(value);
const fixture = () => {
  const world = createPersonalWorld({ id: 'mining-test', name: 'Bergbau' }, getCatalog(), 0);
  world.cards = world.cards.filter((card) => card.type === 'human');
  const get = (id) => world.cards.find((card) => card.id === id);
  const human = () => world.cards.find((card) => card.type === 'human');
  const command = (value, now = 0, rng = () => 0) => applyCommand(world, value, { playerId: world.id, now, rng });
  const move = (card, target, now = 0) => command({ type: 'move', cardId: card.id, targetId: target.id, x: target.x, y: target.y, split: true, takeAbove: true }, now);
  return { world, get, human, command, move };
};
function legacyCatalog() {
  const catalog = clone(DEFAULT_CATALOG);
  catalog.contentVersion = 4;
  for (const type of miningTypes) delete catalog.cardTypes[type];
  catalog.packs = catalog.packs.filter((pack) => pack.id !== 'mining');
  catalog.cardTypes.pickaxe.effects[0].sourceTypes = ['rock'];
  return catalog;
}

test('mining pack costs fifty gold for three draws with only three sources and a rare bat', () => {
  const pack = getPacks().find((entry) => entry.id === 'mining');
  assert.equal(pack.price, 50);
  assert.equal(pack.size, 3);
  assert.deepEqual(pack.contents, [{ type: 'ironVein', weight: 33 }, { type: 'coalVein', weight: 32 }, { type: 'clayPool', weight: 32 }, { type: 'bat', weight: 3 }]);
  assert.equal(Object.keys(CARD_TYPES).some((id) => /gold.*vein|goldader/i.test(id)), false);
  assert.doesNotThrow(() => validateCatalog(clone(DEFAULT_CATALOG)));
  for (const [random, expected] of [[0, 'ironVein'], [.34, 'coalVein'], [.66, 'clayPool'], [.999, 'bat']]) {
    const f = fixture(), purchased = addCard(f.world, 'pack', 1100, 700, { packId: 'mining' });
    for (let remaining = 2; remaining >= 0; remaining--) {
      f.command({ type: 'open-pack', cardId: purchased.id }, 0, () => random);
      assert.equal(f.world.cards.filter((card) => card.type === expected).length, 3 - remaining);
      assert.equal(f.get(purchased.id)?.cardsLeft ?? 0, remaining);
    }
    assert.equal(f.get(purchased.id), undefined);
    assert.throws(() => f.command({ type: 'open-pack', cardId: purchased.id }), /nicht mehr/);
  }
});

test('partial mining payments survive reload and a piggy bank pays only the remaining price', () => {
  const f = fixture(), coin = addCard(f.world, 'gold', 700, 500);
  const initial = f.command({ type: 'move', cardId: coin.id, split: true, takeAbove: false, x: 700, y: 500, zone: 'shop', packId: 'mining' });
  assert.match(initial.message, /Noch 49 Gold/);
  assert.equal(f.world.shopPayments.mining, 1);
  assert.equal(f.world.cards.some((card) => card.type === 'pack'), false);
  const loaded = JSON.parse(JSON.stringify(f.world));
  const pig = addCard(loaded, 'piggyBank', 700, 500, { gold: 60 });
  applyCommand(loaded, { type: 'move', cardId: pig.id, split: true, x: 700, y: 500, zone: 'shop', packId: 'mining' }, { playerId: loaded.id, now: 0 });
  assert.equal(loaded.cards.find((card) => card.id === pig.id).gold, 11);
  assert.equal(loaded.shopPayments.mining, 0);
  assert.equal(loaded.cards.filter((card) => card.type === 'pack' && card.packId === 'mining').length, 1);
  assert.equal(loaded.cards.find((card) => card.type === 'pack').cardsLeft, 3);
});

for (const [sourceType, outputType, pickaxeDuration] of [['ironVein', 'ironOre', 5000], ['coalVein', 'coal', 5000], ['clayPool', 'clay', 10000]]) {
  test(`${sourceType} yields five ${outputType}, depletes, and respects pickaxe timing online and offline`, () => {
    for (const equipped of [false, true]) {
      const f = fixture();
      if (equipped) {
        const tool = addCard(f.world, 'pickaxe', 700, 500);
        f.move(tool, f.human());
      }
      const source = addCard(f.world, sourceType, 1100, 700);
      f.move(f.human(), source);
      const duration = equipped ? pickaxeDuration : 10000;
      assert.equal(f.world.jobs[0].duration, duration);
      advanceWorld(f.world, duration - 1, { rng: () => 0 });
      assert.equal(f.world.cards.filter((card) => card.type === outputType).length, 0);
      advancePersonalWorld(f.world, duration * 5, { activeUntil: duration - 1, rng: () => 0 });
      assert.equal(f.world.cards.filter((card) => card.type === outputType).length, 5);
      assert.equal(f.get(source.id), undefined);
      assert.equal(f.world.jobs.length, 0);
      advancePersonalWorld(f.world, duration * 10, { activeUntil: duration * 5, rng: () => 0 });
      assert.equal(f.world.cards.filter((card) => card.type === outputType).length, 5);
    }
  });
}

test('the bat seeks humans, fights for three hits and drops exactly bone or meat without gold', () => {
  for (const [random, drop] of [[0, 'bone'], [.999, 'meat']]) {
    const f = fixture(), worker = f.human();
    Object.assign(worker, { x: 600, y: 300 });
    const bat = addCard(f.world, 'bat', 1500, 800);
    assert.deepEqual(creatureProfile(f.world, bat), { aggressive: true, behavior: 'seek', target: 'human', speed: 30, hp: 3, damage: 1, attackInterval: 2000 });
    reconcile(f.world, 0);
    assert.equal(bat.motion.targetId, worker.id);
    assert.throws(() => f.command({ type: 'move', cardId: bat.id, x: 600, y: 500 }), /von selbst/);
    // Move the human onto the enemy to start the same public combat path used by dragging.
    f.move(worker, bat);
    assert.equal(f.world.combats.length, 1);
    advanceWorld(f.world, 2000, { rng: () => random });
    assert.equal(f.get(bat.id).hp, 2);
    assert.equal(f.human().hp, 74);
    advanceWorld(f.world, 6000, { rng: () => random });
    assert.equal(f.get(bat.id), undefined);
    assert.equal(f.human().hp, 72);
    assert.equal(f.world.combats.length, 0);
    assert.equal(f.world.cards.filter((card) => card.type === drop).length, 1);
    assert.equal(f.world.cards.some((card) => card.type === 'gold'), false);
  }
});

test('v4 catalogs gain mining lazily and preserve edited content, removed chests and pickaxe tuning', () => {
  const catalog = legacyCatalog();
  catalog.cardTypes.wood.name = 'Bauholz';
  catalog.cardTypes.pickaxe.description = 'Mein eigenes Werkzeug';
  catalog.cardTypes.pickaxe.effects[0].multiplier = .8;
  catalog.cardTypes.pickaxe.effects[0].sourceTypes = ['rock', 'tree'];
  catalog.cardTypes.pickaxe.effects.push({ kind: 'weapon', damage: 3 });
  catalog.packs.find((pack) => pack.id === 'farm').price = 17;
  delete catalog.cardTypes.chest;
  catalog.recipes = catalog.recipes.filter((recipe) => recipe.id !== 'chest');
  const snapshot = JSON.stringify(catalog), upgraded = getCatalog({ catalog });
  assert.equal(upgraded.contentVersion, 5);
  assert.equal(JSON.stringify(catalog), snapshot);
  assert.equal(upgraded.cardTypes.wood.name, 'Bauholz');
  assert.equal(upgraded.cardTypes.pickaxe.description, 'Mein eigenes Werkzeug');
  assert.deepEqual(upgraded.cardTypes.pickaxe.effects, [{ kind: 'tool', sourceTypes: ['rock', 'tree', 'ironVein', 'coalVein'], multiplier: .8 }, { kind: 'weapon', damage: 3 }]);
  assert.equal(upgraded.cardTypes.chest, undefined);
  assert.equal(upgraded.recipes.some((recipe) => recipe.id === 'chest'), false);
  for (const pack of catalog.packs) assert.deepEqual(upgraded.packs.find((entry) => entry.id === pack.id), pack);
  assert.equal(upgraded.packs.filter((pack) => pack.id === 'mining').length, 1);
  assert.doesNotThrow(() => validateCatalog(upgraded));
  assert.equal(getCatalog({ catalog: upgraded }), upgraded);
});

test('mining upgrades preserve custom mining definitions and do not resurrect disabled or deleted pickaxes', () => {
  for (const toolState of ['deleted', 'disabled', 'custom']) {
    const catalog = legacyCatalog();
    if (toolState === 'deleted') { delete catalog.cardTypes.pickaxe; catalog.recipes = catalog.recipes.filter((recipe) => recipe.id !== 'pickaxe'); }
    else catalog.cardTypes.pickaxe.effects = toolState === 'disabled' ? [] : [{ kind: 'weapon', damage: 7 }];
    const customPack = { ...clone(DEFAULT_CATALOG.packs.find((pack) => pack.id === 'mining')), name: 'Meine Mine', price: 81, contents: [{ type: 'rock', weight: 1 }] };
    catalog.packs.push(customPack);
    catalog.cardTypes.ironOre = { ...clone(CARD_TYPES.ironOre), name: 'Eigenes Erz', sellPrice: 7 };
    const upgraded = getCatalog({ catalog });
    assert.deepEqual(upgraded.packs.find((pack) => pack.id === 'mining'), customPack);
    assert.deepEqual(upgraded.cardTypes.ironOre, catalog.cardTypes.ironOre);
    assert.deepEqual(upgraded.cardTypes.pickaxe?.effects, catalog.cardTypes.pickaxe?.effects);
    assert.doesNotThrow(() => validateCatalog(upgraded));
  }
});

test('malformed legacy catalogs keep deleted loot absent without gaining dangling bat drops', () => {
  for (const removed of [['bone'], ['meat'], ['bone', 'meat']]) {
    const catalog = legacyCatalog();
    for (const type of removed) {
      delete catalog.cardTypes[type];
      catalog.recipes = catalog.recipes.filter((recipe) => !Object.hasOwn(recipe.ingredients, type) && recipe.result !== type);
      for (const definition of Object.values(catalog.cardTypes)) if (definition.deathDrops) {
        definition.deathDrops.outputs = definition.deathDrops.outputs.filter((output) => output.type !== type);
        if (!definition.deathDrops.outputs.length) definition.deathDrops.chance = 0;
      }
    }
    const upgraded = getCatalog({ catalog });
    for (const type of removed) assert.equal(upgraded.cardTypes[type], undefined);
    assert.deepEqual(upgraded.cardTypes.bat.deathDrops.outputs.map((output) => output.type), ['bone', 'meat'].filter((type) => !removed.includes(type)));
    assert.equal(upgraded.cardTypes.bat.deathDrops.chance, removed.length === 2 ? 0 : 100);
    // Those three legacy loot/harvest types are mandatory even in v4. Do not
    // bypass that validation or silently re-create a deleted user definition.
    assert.throws(() => validateCatalog(upgraded), /Bestehende Ernte- und Kampfmechanik/);
  }
});

test('saving v5 makes later editor deletion of unused mining content permanent', () => {
  const catalog = clone(DEFAULT_CATALOG);
  for (const type of miningTypes) delete catalog.cardTypes[type];
  catalog.packs = catalog.packs.filter((pack) => pack.id !== 'mining');
  catalog.cardTypes.pickaxe.effects[0].sourceTypes = ['rock'];
  const validated = validateCatalog(catalog);
  assert.equal(validated.contentVersion, 5);
  assert.equal(getCatalog({ catalog: validated }), validated);
  assert.equal(getCardTypes({ catalog: validated }).ironVein, undefined);
  assert.equal(getPacks({ catalog: validated }).some((pack) => pack.id === 'mining'), false);
});
