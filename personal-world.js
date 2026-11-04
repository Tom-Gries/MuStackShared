import { CARD_TYPES, RECIPES, getCatalog, getCardDefinition, getPacks } from './catalog.js';
import { addCard, createWorld, joinPlayer, reconcile, removeCards } from './game.js';
import { creatureProfile } from './creatures.js';
import { combatEnemyIds, combatHumanIds } from './combat.js';

const clone = (value) => JSON.parse(JSON.stringify(value));
const fail = (message) => { throw Object.assign(new Error(message), { status: 400 }); };
const cardFields = ['remaining', 'gold', 'hp', 'readyAt', 'packId', 'packName', 'packColor', 'packSize', 'packContents', 'cardsLeft'];

function identifier(value, label) {
  if (typeof value !== 'string' || !value || value.length > 200 || /[\u0000-\u001f\u007f]/u.test(value)) fail(`${label} ist ungültig.`);
  return value;
}

/** Add new personal-world content to an older canonical catalog without replacing edits. */
export function ensurePersonalCatalog(catalog) {
  const result = clone(getCatalog(catalog ? { catalog } : undefined));
  result.cardTypes.town_hall ??= clone(CARD_TYPES.town_hall);
  const recipe = RECIPES.find((entry) => entry.id === 'town_hall');
  const signature = (entry) => JSON.stringify(Object.entries(entry.ingredients).sort(([a], [b]) => a.localeCompare(b)));
  if (result.cardTypes.stone && !result.recipes.some((entry) => entry.id === recipe.id || signature(entry) === signature(recipe))) {
    result.recipes.push(clone(recipe));
  }
  return result;
}

/** New accounts start independently; the canonical content is copied, not shared by reference. */
export function createPersonalWorld(player, catalog, now = Date.now()) {
  if (!player || typeof player !== 'object') fail('Der Spieler fehlt.');
  identifier(player.id, 'Spieler-ID');
  const world = createWorld(now);
  world.id = player.id;
  world.catalog = ensurePersonalCatalog(catalog);
  world.shopPayments = Object.fromEntries(getPacks(world).map((pack) => [pack.id, 0]));
  const joined = joinPlayer(world, player.name, now);
  joined.id = player.id;
  const human = world.cards.find((card) => card.id === joined.cardId);
  human.ownerId = player.id;
  return world;
}

/** Material counts are card counts; coins stored inside a piggy bank count as gold too. */
export function summarizeMaterials(world) {
  const counts = new Map();
  for (const card of world.cards.flatMap((card) => [card, ...(card.type === 'chest' ? card.contents || [] : [])])) {
    if (card.type === 'human' || card.type === 'corpse') continue;
    counts.set(card.type, (counts.get(card.type) || 0) + 1);
    if (card.type === 'piggyBank' && Number.isSafeInteger(card.gold) && card.gold > 0) {
      counts.set('gold', (counts.get('gold') || 0) + card.gold);
    }
  }
  return [...counts].sort(([a], [b]) => a.localeCompare(b)).map(([type, count]) => ({ type, count }));
}

function assertGiftable(world, card, checkReferences = false) {
  identifier(card.type, 'Kartentyp');
  if (!getCardDefinition(world, card.type)) fail('Dieser Kartentyp ist nicht mehr vorhanden.');
  if (card.type === 'human' || card.type === 'corpse') fail('Menschen und Leichen können nicht verschenkt werden.');
  if (card.contents !== undefined && (card.type !== 'chest' || !Array.isArray(card.contents))) fail('Der Kisteninhalt ist ungültig.');
  if (card.type === 'chest' && card.contents?.length) fail('Leere die Kiste vor dem Verschenken, damit ihr Inhalt erhalten bleibt.');
  if (creatureProfile(world, card)?.aggressive) fail('Angreifende Lebewesen können nicht verschenkt werden.');
  if (card.equippedTo || (checkReferences && world.cards.some((human) => human.toolId === card.id))) fail('Lege das Werkzeug vor dem Verschenken ab.');
}

function snapshot(card) {
  const result = { id: card.id, type: card.type, stackId: card.stackId || card.id, order: card.order || 0 };
  for (const key of cardFields) if (card[key] !== undefined) result[key] = clone(card[key]);
  return result;
}

/** Detach the same card selection as a drag. Rejected gifts leave the world untouched. */
export function takeGiftCards(world, { cardId, split = true, takeAbove = true } = {}, now = Date.now()) {
  if (typeof split !== 'boolean' || typeof takeAbove !== 'boolean') fail('Die Kartenauswahl ist ungültig.');
  const selected = world.cards.find((card) => card.id === cardId);
  if (!selected) fail('Diese Karte ist nicht mehr vorhanden.');
  const group = world.cards.filter((card) => card.stackId === selected.stackId);
  const material = selected.equippedTo ? [selected] : takeAbove
    ? group.filter((card) => !card.equippedTo && card.order >= selected.order)
    : split ? [selected] : group.filter((card) => !card.equippedTo);
  const selectedIds = new Set(material.map((card) => card.id));
  const cards = world.cards.filter((card) => selectedIds.has(card.id)
    || (!selected.equippedTo && selectedIds.has(card.equippedTo)));
  if (!cards.length) fail('Die Kartenauswahl ist ungültig.');
  const ids = new Set(cards.map((card) => card.id));
  const busy = new Set([
    ...world.jobs.flatMap((job) => [...(job.cardIds || []), job.humanId, job.sourceId]),
    ...world.combats.flatMap((combat) => [...combatHumanIds(combat), ...combatEnemyIds(combat)]),
  ].filter(Boolean));
  for (const card of cards) {
    assertGiftable(world, card, true);
    if (busy.has(card.id)) fail('Karten in einer laufenden Arbeit oder einem Kampf können nicht verschenkt werden.');
  }
  const gifts = cards.map(snapshot);
  const draft = clone(world);
  removeCards(draft, [...ids]);
  reconcile(draft, now);
  Object.assign(world, draft);
  return gifts;
}

function validateSnapshot(world, card) {
  if (!card || typeof card !== 'object' || Array.isArray(card)) fail('Das Geschenk enthält eine ungültige Karte.');
  identifier(card.id, 'Karten-ID');
  identifier(card.stackId || card.id, 'Stapel-ID');
  assertGiftable(world, card);
  if (card.toolId) fail('Ausgerüstete Karten können nicht verschenkt werden.');
  if (card.order !== undefined && (!Number.isSafeInteger(card.order) || card.order < 0)) fail('Die Stapelreihenfolge ist ungültig.');
  for (const key of ['remaining', 'gold', 'cardsLeft']) {
    if (card[key] !== undefined && (!Number.isSafeInteger(card[key]) || card[key] < 0)) fail('Der Karteninhalt ist ungültig.');
  }
  for (const key of ['hp', 'readyAt']) {
    if (card[key] !== undefined && (!Number.isFinite(card[key]) || card[key] < 0)) fail('Der Kartenzustand ist ungültig.');
  }
  if (card.type === 'pack') {
    if (card.packSize !== undefined && (!Number.isSafeInteger(card.packSize) || card.packSize < 1 || card.packSize > 30)) fail('Die Paketgröße ist ungültig.');
    if (card.cardsLeft !== undefined && card.cardsLeft > (card.packSize ?? 30)) fail('Der Paketinhalt ist ungültig.');
    for (const key of ['packId', 'packName', 'packColor']) if (card[key] !== undefined && (typeof card[key] !== 'string' || card[key].length > 200)) fail('Die Paketbeschreibung ist ungültig.');
    if (card.packContents !== undefined && (!Array.isArray(card.packContents) || !card.packContents.length
      || card.packContents.length > 200 || card.packContents.some((entry) => !entry || !getCardDefinition(world, entry.type)
        || !Number.isFinite(entry.weight) || entry.weight <= 0))) fail('Der Paketinhalt enthält unbekannte Karten.');
  }
}

/** Recreate gifts with destination IDs; no sender references or running work cross worlds. */
export function receiveGiftCards(world, cards, now = Date.now()) {
  if (!Array.isArray(cards) || !cards.length) fail('Das Geschenk ist ungültig.');
  const seen = new Set();
  for (const card of cards) {
    validateSnapshot(world, card);
    if (seen.has(card.id)) fail('Das Geschenk enthält eine Karte mehrfach.');
    seen.add(card.id);
  }
  const draft = clone(world);
  if (!Number.isSafeInteger(draft.nextId) || draft.nextId < 1) fail('Die Welt enthält ungültige Karten-IDs.');
  const reserved = new Set([
    ...draft.cards.flatMap((card) => [card.id, card.stackId]),
    ...draft.players.map((player) => player.id), ...draft.jobs.map((job) => job.id), ...draft.combats.map((combat) => combat.id),
    ...cards.flatMap((card) => [card.id, card.stackId]),
  ]);
  const groups = new Map();
  for (const card of cards) {
    const key = card.stackId || card.id;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(card);
  }
  const human = draft.cards.find((card) => card.type === 'human' && card.ownerId === draft.id)
    || draft.cards.find((card) => card.type === 'human') || draft.cards.find((card) => card.type === 'corpse');
  const origin = { x: (human?.x ?? 340) + 155, y: (human?.y ?? 180) + 15 };
  const received = new Map();
  for (const group of groups.values()) {
    let base;
    for (const [order, source] of [...group].sort((a, b) => (a.order || 0) - (b.order || 0)).entries()) {
      while (reserved.has(`c${draft.nextId}`)) draft.nextId++;
      if (!Number.isSafeInteger(draft.nextId)) fail('Es konnten keine neuen Karten-IDs erstellt werden.');
      const extra = Object.fromEntries(cardFields.filter((key) => source[key] !== undefined).map((key) => [key, clone(source[key])]));
      if (base) Object.assign(extra, { stackId: base.stackId, order });
      const card = addCard(draft, source.type, base?.x ?? origin.x, base?.y ?? origin.y, extra);
      base ??= card;
      reserved.add(card.id);
      received.set(source.id, card.id);
    }
  }
  reconcile(draft, now);
  Object.assign(world, draft);
  return cards.map((card) => received.get(card.id));
}
