import { advancePersonalWorld, applyCommand } from './game.js';

export const MAX_SIMULATION_OPERATIONS = 500;
const MAX_TIMESTAMP = 8_640_000_000_000_000;
const clone = (value) => structuredClone(value);
const fail = (message) => { throw Object.assign(new Error(message), { status: 400 }); };

function timestamp(value, label) {
  if (!Number.isFinite(value) || value < 0 || value > MAX_TIMESTAMP) fail(`${label} ist ungültig.`);
  return value;
}

/** A world owns its random stream; loading it never rerolls saved outcomes. */
export function initializeLocalSimulation(world) {
  if (!world || typeof world !== 'object' || !world.clock || !Array.isArray(world.players)) fail('Der Spielstand ist ungültig.');
  if (world.randomState !== undefined && world.randomState !== null) {
    if (!Number.isInteger(world.randomState) || world.randomState < 0 || world.randomState > 0xffff_ffff) fail('Der Zufallszustand des Spielstands ist ungültig.');
    return world;
  }
  if (typeof world.id !== 'string' || !world.id) fail('Die Welt-ID fehlt.');
  let seed = 2_166_136_261;
  for (let index = 0; index < world.id.length; index++) seed = Math.imul(seed ^ world.id.charCodeAt(index), 16_777_619) >>> 0;
  world.randomState = seed;
  return world;
}

function randomStream(seed) {
  let state = seed;
  return {
    next() {
      state = (state + 0x6d2b_79f5) >>> 0;
      let value = Math.imul(state ^ state >>> 15, state | 1);
      value ^= value + Math.imul(value ^ value >>> 7, value | 61);
      return ((value ^ value >>> 14) >>> 0) / 4_294_967_296;
    },
    state: () => state,
  };
}

function validateOperation(world, operation, playerId, maxTime = Infinity) {
  if (!operation || typeof operation !== 'object' || Array.isArray(operation) || !['advance', 'command'].includes(operation.kind)) fail('Die lokale Spielaktion ist ungültig.');
  if (!world.players.some((player) => player.id === playerId)) fail('Der Spieler gehört nicht zu dieser Welt.');
  const at = timestamp(operation.at, 'Der Aktionszeitpunkt');
  const activeUntil = operation.activeUntil === undefined ? at : timestamp(operation.activeUntil, 'Die aktive Spielzeit');
  if (at < world.clock.lastAt) fail('Die Spielaktionen sind nicht zeitlich geordnet.');
  if (at > maxTime) fail('Die Spielaktion liegt in der Zukunft.');
  if (activeUntil > at) fail('Die aktive Spielzeit liegt nach dem Aktionszeitpunkt.');
  if (operation.kind === 'command') {
    const command = operation.command;
    if (!command || typeof command !== 'object' || Array.isArray(command) || command.type === 'catalog-save') fail('Diese Spielaktion muss separat gespeichert werden.');
  }
  return { at, activeUntil };
}

const visualState = (world) => JSON.stringify({ cards: world.cards, jobs: world.jobs, combats: world.combats, shopPaid: world.shopPaid, shopPayments: world.shopPayments, nextId: world.nextId });

function runOperation(world, operation, playerId, maxTime) {
  const { at, activeUntil } = validateOperation(world, operation, playerId, maxTime);
  initializeLocalSimulation(world);
  const before = visualState(world);
  const random = randomStream(world.randomState);
  advancePersonalWorld(world, at, { activeUntil, rng: () => random.next() });
  let outcome;
  if (operation.kind === 'command') outcome = applyCommand(world, operation.command, { playerId, now: at, rng: () => random.next() });
  // applyCommand clones the input world internally, so publish the external
  // stream's final state only after its draft has been committed.
  world.randomState = random.state();
  return { changed: visualState(world) !== before, ...(outcome?.message ? { message: outcome.message } : {}) };
}

/** Execute immediately in the browser; errors roll back time, cards and RNG. */
export function applySimulationOperation(world, operation, { playerId = world?.id } = {}) {
  const draft = clone(world);
  const result = runOperation(draft, operation, playerId, Infinity);
  Object.assign(world, draft);
  return result;
}

/** Replay exactly the recorded engine calls at save time, never frame updates. */
export function replaySimulationBatch(world, operations, { playerId = world?.id, maxTime = Infinity } = {}) {
  if (!Array.isArray(operations) || operations.length > MAX_SIMULATION_OPERATIONS) fail(`Ein Speicherpaket darf höchstens ${MAX_SIMULATION_OPERATIONS} Spielaktionen enthalten.`);
  if (maxTime !== Infinity) timestamp(maxTime, 'Der Speicherzeitpunkt');
  const draft = clone(world);
  initializeLocalSimulation(draft);
  let changed = false, message;
  for (const operation of operations) {
    const result = runOperation(draft, operation, playerId, maxTime);
    changed ||= result.changed;
    if (result.message) message = result.message;
  }
  Object.assign(world, draft);
  return { changed, ...(message ? { message } : {}) };
}
