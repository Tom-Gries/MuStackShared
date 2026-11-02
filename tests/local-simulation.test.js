import test from 'node:test';
import assert from 'node:assert/strict';
import { getCatalog } from '../catalog.js';
import { addCard, applyCommand, reconcile } from '../game.js';
import { createPersonalWorld } from '../personal-world.js';
import { initializeLocalSimulation, applySimulationOperation, replaySimulationBatch, MAX_SIMULATION_OPERATIONS } from '../local-simulation.js';

const make = (id = 'alice') => createPersonalWorld({ id, name: id }, getCatalog(), 0);
const copy = (value) => structuredClone(value);
const human = (world) => world.cards.find((card) => card.type === 'human');
const count = (world, type) => world.cards.filter((card) => card.type === type).length;
const advance = (at, activeUntil = at) => ({ kind: 'advance', at, activeUntil });
const command = (at, value) => ({ kind: 'command', at, activeUntil: at, command: value });
const move = (cardId, targetId, x = 1000, y = 500) => ({ type: 'move', cardId, targetId, x, y, split: true, takeAbove: true });

function runLocally(base, operations) {
  const world = copy(base), messages = [];
  for (const operation of operations) messages.push(applySimulationOperation(world, operation));
  return { world, messages };
}

test('old worlds receive one deterministic saved random stream and existing outcomes are untouched', () => {
  const base = make(), before = copy(base), one = copy(base), two = copy(base);
  initializeLocalSimulation(one); initializeLocalSimulation(two);
  assert.equal(one.randomState, two.randomState);
  assert.ok(Number.isInteger(one.randomState) && one.randomState >= 0 && one.randomState <= 0xffff_ffff);
  delete one.randomState;
  assert.deepEqual(one, before);
  const other = make('bob'); initializeLocalSimulation(other);
  initializeLocalSimulation(one);
  assert.notEqual(one.randomState, other.randomState);
  one.randomState = 0;
  initializeLocalSimulation(one);
  assert.equal(one.randomState, 0);
  for (const randomState of [-1, 0x1_0000_0000, NaN, .5, '1']) assert.throws(() => initializeLocalSimulation({ ...copy(base), randomState }), { status: 400 });
});

test('pack clicks use saved randomness and browser execution exactly matches server replay', () => {
  const base = make(), pack = addCard(base, 'pack', 1000, 500, { packId: 'basic' });
  initializeLocalSimulation(base);
  const operations = [command(100, { type: 'open-pack', cardId: pack.id }), command(200, { type: 'open-pack', cardId: pack.id }), command(300, { type: 'open-pack', cardId: pack.id }), advance(301)];
  const { world: local, messages } = runLocally(base, operations);
  const server = copy(base), replay = replaySimulationBatch(server, operations, { maxTime: 301 });
  assert.deepEqual(server, local);
  assert.notEqual(local.randomState, base.randomState);
  assert.equal(local.cards.some((card) => card.id === pack.id), false);
  assert.equal(messages.filter((message) => message.message).length, 3);
  assert.equal(replay.message, messages[2].message);
  assert.equal(count(local, 'human'), 1);
});

test('source yield and card IDs remain identical across multiple saves and varied event boundaries', () => {
  const base = make(), tree = addCard(base, 'tree', 1000, 500);
  const operations = [command(0, move(human(base).id, tree.id)), advance(10_100), advance(20_200), advance(30_300), advance(40_400), advance(50_500), command(50_600, move(human(base).id, undefined, 1400, 700))];
  const local = runLocally(base, operations).world;
  const server = copy(base);
  replaySimulationBatch(server, operations.slice(0, 3), { maxTime: 20_200 });
  const saved = copy(server);
  replaySimulationBatch(server, operations.slice(3), { maxTime: 50_600 });
  const restarted = copy(saved);
  replaySimulationBatch(restarted, operations.slice(3), { maxTime: 50_600 });
  assert.deepEqual(server, local);
  assert.deepEqual(restarted, local);
  assert.equal(count(local, 'wood') + count(local, 'stick'), 5);
  assert.equal(local.cards.some((card) => card.id === tree.id), false);
  assert.equal(human(local).x, 1400);
});

test('combat loot is reproducible without calling the global random generator', () => {
  const base = make(), worker = human(base);
  addCard(base, 'rat', worker.x + 10, worker.y, { stackId: 'enemy', order: 0 });
  reconcile(base, 0);
  assert.equal(base.combats.length, 1);
  const operations = [advance(2000), advance(4000), advance(10_000)];
  const globalRandom = Math.random;
  let local, server;
  try {
    Math.random = () => { throw new Error('Global RNG must not be called'); };
    local = runLocally(base, operations).world;
    server = copy(base); replaySimulationBatch(server, operations);
  } finally { Math.random = globalRandom; }
  assert.deepEqual(server, local);
  assert.equal(count(local, 'rat'), 0);
  assert.equal(local.combats.length, 0);
  assert.equal(human(local).hp, 73);
});

test('source queues and attached tools behave identically during local offline catch-up', () => {
  const base = make(), worker = human(base);
  const axe = addCard(base, 'axe', worker.x, worker.y, { stackId: worker.stackId, order: worker.order, equippedTo: worker.id });
  worker.toolId = axe.id;
  const tree = addCard(base, 'tree', 1000, 500, { stackId: 'sources', order: 0 });
  const rock = addCard(base, 'rock', tree.x, tree.y, { stackId: 'sources', order: 1 });
  const operations = [command(0, move(worker.id, tree.id)), advance(75_000, 0)];
  const local = runLocally(base, operations).world;
  const server = copy(base); replaySimulationBatch(server, operations);
  assert.deepEqual(server, local);
  assert.equal(local.cards.some((card) => [tree.id, rock.id].includes(card.id)), false);
  assert.equal(count(local, 'wood') + count(local, 'stick'), 5);
  assert.equal(count(local, 'stone') + count(local, 'flint'), 5);
  assert.equal(human(local).toolId, axe.id);
});

test('hidden time finishes work while preserving paused combat and movement', () => {
  const base = make(), worker = human(base);
  addCard(base, 'rat', worker.x + 10, worker.y, { stackId: 'enemy', order: 0 });
  const animal = addCard(base, 'cow', 1800, 1000, { stackId: 'animal', order: 0 });
  reconcile(base, 0);
  const operations = [advance(1000), advance(86_400_000, 1000), advance(86_401_000)];
  const local = runLocally(base, operations).world;
  const server = copy(base); replaySimulationBatch(server, operations);
  assert.deepEqual(server, local);
  assert.equal(human(local).hp, 74);
  assert.ok(local.cards.find((card) => card.id === animal.id));
});

test('a rejected command rolls back elapsed work, IDs and random state together', () => {
  const world = make(), tree = addCard(world, 'tree', 1000, 500);
  applyCommand(world, move(human(world).id, tree.id), { playerId: world.id, now: 0 });
  initializeLocalSimulation(world);
  const before = copy(world);
  assert.throws(() => applySimulationOperation(world, command(60_000, { type: 'open-pack', cardId: 'missing' })));
  assert.deepEqual(world, before);
});

test('a later invalid entry rejects the entire batch including already drawn pack cards', () => {
  const world = make(), pack = addCard(world, 'pack', 1000, 500, { packId: 'basic' });
  const before = copy(world);
  assert.throws(() => replaySimulationBatch(world, [command(10, { type: 'open-pack', cardId: pack.id }), command(20, { type: 'withdraw', cardId: pack.id })]));
  assert.deepEqual(world, before);
});

test('malformed, unordered, future and oversized batches fail without changing the world', () => {
  const world = make(), before = copy(world);
  const invalid = [null, {}, Array.from({ length: MAX_SIMULATION_OPERATIONS + 1 }, () => advance(0)), [advance(-1)], [advance(NaN)], [advance(Infinity)], [advance(10, 11)], [advance(20), advance(10)], [{ kind: 'other', at: 0 }], [{ kind: 'command', at: 0, command: [] }]];
  for (const operations of invalid) {
    assert.throws(() => replaySimulationBatch(world, operations), { status: 400 });
    assert.deepEqual(world, before);
  }
  assert.throws(() => replaySimulationBatch(world, [advance(101)], { maxTime: 100 }), { status: 400 });
  assert.throws(() => replaySimulationBatch(world, [advance(10)], { playerId: 'someone-else' }), { status: 400 });
  assert.deepEqual(world, before);
});

test('global catalog edits and forged human creation are never local simulation commands', () => {
  const world = make(), before = copy(world);
  assert.throws(() => applySimulationOperation(world, command(0, { type: 'catalog-save', catalog: getCatalog() })), { status: 400 });
  assert.throws(() => applySimulationOperation(world, command(0, { type: 'join', name: 'Extra human' })));
  assert.deepEqual(world, before);
  const operation = { ...advance(1), cards: [{ id: 'fake', type: 'human' }], randomState: 123 };
  applySimulationOperation(world, operation);
  assert.equal(count(world, 'human'), 1);
  assert.equal(world.cards.some((card) => card.id === 'fake'), false);
});

test('clock-only checkpoints do not demand a visual redraw but remain reproducible saves', () => {
  const world = make(), before = copy(world);
  assert.equal(applySimulationOperation(world, advance(1000)).changed, false);
  assert.equal(world.clock.lastAt, 1000);
  assert.equal(world.clock.elapsed, 1000);
  const saved = copy(before); replaySimulationBatch(saved, [advance(1000)]);
  assert.deepEqual(saved, world);
});
