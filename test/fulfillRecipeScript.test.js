'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseRecipe } = require('../lib/parseRecipe.js');
const {
	findDynamicRecipeItems,
	selectComponentsForSlot,
	buildPlan,
	categoryFor,
	describeItem,
	weaponRequirementText,
	requiredWeaponTier,
	collectWeaponChoices,
	humanizeInternalName,
	resolveDisplayName,
	detectKillstreakTier,
	findWeaponCandidates,
} = require('../scripts/fulfill-recipe.js');

// Real encoding (confirmed against a real captured weapon): killstreak tier
// lives in attribute 2025's value_bytes, as a little-endian float32.
function killstreakTierAttribute(tier) {
	const buf = Buffer.alloc(4);
	buf.writeFloatLE(tier, 0);
	return { def_index: 2025, value_bytes: buf };
}

const { specializedFabricator1, specializedFabricator2, professionalFabricator } = require('./fixtures/realFabricators.js');

test('findDynamicRecipeItems only picks items with 2000-2009 attributes', () => {
	const backpack = [specializedFabricator1, { id: '999', def_index: 1, attribute: [{ def_index: 1, value: 1 }] }];
	const found = findDynamicRecipeItems(backpack);
	assert.deepEqual(
		found.map((i) => i.id),
		[specializedFabricator1.id]
	);
});

test('selectComponentsForSlot picks the largest single stack first and marks satisfied when enough', () => {
	const recipe = parseRecipe(specializedFabricator1);
	const slot = recipe.inputs.find((s) => s.attributeIndex === 2001); // itemdef 5705 x12
	const backpack = [{ id: 'a', def_index: 5705, quality: 6, quantity: 20 }, { id: 'b', def_index: 5705, quality: 6, quantity: 20 }];

	const result = selectComponentsForSlot(backpack, slot, recipe.toolItemId, new Map());

	assert.equal(result.satisfied, true);
	assert.equal(result.chosen.length, 1);
	assert.equal(result.chosen[0].id, 'a');
	assert.equal(result.chosen[0].quantity, 12);
});

test('selectComponentsForSlot splits across stacks when no single stack is enough', () => {
	const recipe = parseRecipe(specializedFabricator1);
	const slot = recipe.inputs.find((s) => s.attributeIndex === 2001); // needs 12
	const backpack = [{ id: 'a', def_index: 5705, quality: 6, quantity: 7 }, { id: 'b', def_index: 5705, quality: 6, quantity: 5 }];

	const result = selectComponentsForSlot(backpack, slot, recipe.toolItemId, new Map());

	assert.equal(result.satisfied, true);
	assert.deepEqual(
		result.chosen.map((c) => c.quantity),
		[7, 5]
	);
});

test('selectComponentsForSlot reports a shortfall instead of over-claiming', () => {
	const recipe = parseRecipe(specializedFabricator1);
	const slot = recipe.inputs.find((s) => s.attributeIndex === 2001); // needs 12
	const backpack = [{ id: 'a', def_index: 5705, quality: 6, quantity: 5 }];

	const result = selectComponentsForSlot(backpack, slot, recipe.toolItemId, new Map());

	assert.equal(result.satisfied, false);
	assert.equal(result.shortBy, 7);
});

test('selectComponentsForSlot never double-books a stack already reserved by an earlier slot', () => {
	// Two Professional inputs (2004, 2005) both require the SAME itemdef+quality
	// combo (5701 and 5700 respectively don't collide in this real fixture, so
	// force a collision here to exercise the safeguard directly).
	const recipe = parseRecipe(professionalFabricator);
	const slotA = { attributeIndex: 9001, itemDefIndex: 5701, quality: 6, quantityRequired: 6 };
	const slotB = { attributeIndex: 9002, itemDefIndex: 5701, quality: 6, quantityRequired: 6 };
	const backpack = [{ id: 'a', def_index: 5701, quality: 6, quantity: 10 }];

	const reserved = new Map();
	const resultA = selectComponentsForSlot(backpack, slotA, recipe.toolItemId, reserved);
	const resultB = selectComponentsForSlot(backpack, slotB, recipe.toolItemId, reserved);

	assert.equal(resultA.satisfied, true);
	assert.deepEqual(resultA.chosen, [{ id: 'a', quantity: 6 }]);

	// Only 4 left after slot A reserved 6 of the 10 available
	assert.equal(resultB.satisfied, false);
	assert.equal(resultB.chosen.length, 1);
	assert.equal(resultB.chosen[0].quantity, 4);
	assert.equal(resultB.shortBy, 2);
});

test('selectComponentsForSlot excludes the tool item itself as a candidate', () => {
	// Pathological but guards against a Fabricator accidentally matching its own defindex/quality as a component
	const recipe = parseRecipe(specializedFabricator1);
	const slot = { attributeIndex: 9003, itemDefIndex: specializedFabricator1.def_index, quality: specializedFabricator1.quality, quantityRequired: 1 };
	const backpack = [specializedFabricator1];

	const result = selectComponentsForSlot(backpack, slot, specializedFabricator1.id, new Map());

	assert.equal(result.satisfied, false);
	assert.equal(result.chosen.length, 0);
});

test('buildPlan: allSatisfied is true when every input slot resolves for a real fabricator', () => {
	const recipe = parseRecipe(specializedFabricator1);
	const backpack = [
		specializedFabricator1,
		{ id: '1', def_index: 5705, quality: 6, quantity: 12 },
		{ id: '2', def_index: 5707, quality: 6, quantity: 9 },
		{ id: '3', def_index: 5706, quality: 6, quantity: 3 },
		{ id: '4', def_index: 5702, quality: 6, quantity: 5 },
	];

	const { plan, allSatisfied } = buildPlan(backpack, recipe);
	assert.equal(allSatisfied, true);
	assert.equal(plan.length, 4);
});

test('categoryFor names the two confirmed tool def_indexes and falls back for unknown ones', () => {
	assert.equal(categoryFor(20002), 'Specialized Killstreak Kit Fabricator');
	assert.equal(categoryFor(20003), 'Professional Killstreak Kit Fabricator');
	assert.match(categoryFor(12345), /12345.*no confirmada/);
});

test('describeItem summarizes a real Specialized fabricator with category, output, and inputs', () => {
	const described = describeItem(specializedFabricator1);

	assert.equal(described.error, null);
	assert.equal(described.category, 'Specialized Killstreak Kit Fabricator');
	assert.equal(described.recipe.output.itemDefIndex, 6523);
	assert.equal(described.recipe.inputs.length, 4);
});

test('describeItem summarizes a real Professional fabricator distinctly from Specialized', () => {
	const described = describeItem(professionalFabricator);
	assert.equal(described.category, 'Professional Killstreak Kit Fabricator');
	assert.notEqual(described.category, categoryFor(specializedFabricator2.def_index));
});

test('describeItem never throws - returns an error string instead for an unparseable item', () => {
	const described = describeItem({ id: '1', def_index: 99999, attribute: [] });
	assert.equal(described.recipe, null);
	assert.match(described.error, /no dynamic-recipe attributes/);
});

test('weaponRequirementText gives the confirmed disclaimer for Specialized and Professional, and a fallback otherwise', () => {
	assert.match(weaponRequirementText(20002), /Killstreak Kit normal/);
	assert.match(weaponRequirementText(20003), /Specialized Killstreak Kit/);
	assert.match(weaponRequirementText(12345), /no confirmado/);
});

test('requiredWeaponTier maps Specialized to tier 1 and Professional to tier 2, null for unknown tools', () => {
	assert.equal(requiredWeaponTier(20002), 1);
	assert.equal(requiredWeaponTier(20003), 2);
	assert.equal(requiredWeaponTier(12345), null);
});

const fakeItemSchema = {
	items: {
		205: { name: 'TF_WEAPON_ROCKETLAUNCHER', item_slot: 'primary', item_name: '#TF_Weapon_RocketLauncher' },
		210: { name: 'TF_WEAPON_SHOTGUN', item_slot: 'secondary', item_name: '#TF_Weapon_Shotgun' },
		404: { name: 'TF_WEAPON_BOTTLE', item_slot: 'melee' }, // no item_name token - exercises the humanized fallback
		999: { name: 'SOME_HAT', item_slot: 'head' }, // not a weapon slot - must be excluded from candidates
	},
};
const fakeLang = { TF_Weapon_RocketLauncher: 'Rocket Launcher', TF_Weapon_Shotgun: 'Shotgun' };

test('humanizeInternalName turns an internal dev name into something readable', () => {
	assert.equal(humanizeInternalName('TF_WEAPON_FIREAXE'), 'Fireaxe');
	assert.equal(humanizeInternalName('TF_WEAPON_ROCKETLAUNCHER'), 'Rocketlauncher');
	assert.equal(humanizeInternalName(null), null);
});

test('resolveDisplayName prefers the real localized name over the internal dev name', () => {
	assert.equal(resolveDisplayName(205, fakeItemSchema, fakeLang), 'Rocket Launcher');
});

test('resolveDisplayName falls back to a humanized internal name when there is no lang token', () => {
	assert.equal(resolveDisplayName(404, fakeItemSchema, fakeLang), 'Bottle');
	assert.equal(resolveDisplayName(205, fakeItemSchema, null), 'Rocketlauncher');
});

test('resolveDisplayName falls back to a bare defindex when the item is unknown to the schema', () => {
	assert.equal(resolveDisplayName(123456789, fakeItemSchema, fakeLang), 'defindex 123456789');
});

test('detectKillstreakTier reads the killstreak tier off a weapon\'s own attribute 2025 value_bytes (real encoding, confirmed via a real captured weapon)', () => {
	const tier1 = { attribute: [killstreakTierAttribute(1)] };
	const tier2 = { attribute: [killstreakTierAttribute(2)] };
	assert.equal(detectKillstreakTier(tier1), 1);
	assert.equal(detectKillstreakTier(tier2), 2);
});

test('detectKillstreakTier returns null when the weapon has no killstreak tier attribute at all', () => {
	assert.equal(detectKillstreakTier({ attribute: [] }), null);
	assert.equal(detectKillstreakTier({}), null);
});

test('detectKillstreakTier ignores a stray "value" field - the real encoding is in value_bytes, not value', () => {
	// A real dumped weapon had value: null / absent entirely, only value_bytes set.
	assert.equal(detectKillstreakTier({ attribute: [{ def_index: 2025, value: 1065353216 }] }), null);
});

test('findWeaponCandidates only includes Unique combat weapons, excludes cosmetics and non-Unique items, and annotates detected tier', () => {
	const backpack = [
		{ id: 'w1', def_index: 205, quality: 6, attribute: [killstreakTierAttribute(1)] },
		{ id: 'w2', def_index: 210, quality: 6, attribute: [] }, // no killstreak detected
		{ id: 'notunique', def_index: 205, quality: 3, attribute: [] }, // wrong quality
		{ id: 'hat', def_index: 999, quality: 6, attribute: [] }, // wrong item_slot
	];

	const candidates = findWeaponCandidates(backpack, fakeItemSchema, fakeLang, null);

	assert.deepEqual(
		candidates.map((c) => c.id).sort(),
		['w1', 'w2']
	);
	const w1 = candidates.find((c) => c.id === 'w1');
	assert.equal(w1.displayName, 'Rocket Launcher');
	assert.equal(w1.detectedTier, 1);
	assert.equal(candidates.find((c) => c.id === 'w2').detectedTier, null);
});

test('findWeaponCandidates marks matchesRequirement and sorts matching candidates first', () => {
	const backpack = [
		{ id: 'wrong-tier', def_index: 205, quality: 6, attribute: [killstreakTierAttribute(2)] },
		{ id: 'no-killstreak', def_index: 210, quality: 6, attribute: [] },
		{ id: 'matching', def_index: 210, quality: 6, attribute: [killstreakTierAttribute(1)] },
	];

	const candidates = findWeaponCandidates(backpack, fakeItemSchema, fakeLang, 1);

	assert.equal(candidates[0].id, 'matching');
	assert.equal(candidates[0].matchesRequirement, true);
	assert.equal(candidates.find((c) => c.id === 'wrong-tier').matchesRequirement, false);
	assert.equal(candidates.find((c) => c.id === 'no-killstreak').matchesRequirement, false);
});

test('findWeaponCandidates never marks matchesRequirement true when requiredTier is unknown (null)', () => {
	const backpack = [{ id: 'w1', def_index: 205, quality: 6, attribute: [killstreakTierAttribute(1)] }];
	const candidates = findWeaponCandidates(backpack, fakeItemSchema, fakeLang, null);
	assert.equal(candidates[0].matchesRequirement, false);
});

test('collectWeaponChoices never asks for a raw id - lists candidates and accepts an index', async () => {
	const recipe = parseRecipe(specializedFabricator1); // 1 weaponChoice slot (2000), quantityRequired 1
	const backpack = [{ id: '42', def_index: 205, quality: 6, attribute: [] }];

	const askedQuestions = [];
	const fakeAsk = async (question) => {
		askedQuestions.push(question);
		return '0'; // pick candidate index 0
	};

	const assignments = await collectWeaponChoices(recipe, backpack, fakeItemSchema, fakeLang, fakeAsk);

	assert.equal(askedQuestions.length, 1);
	assert.deepEqual(assignments, { 2000: ['42'] });
});

test('collectWeaponChoices accepts comma-separated indices for a Professional fabricator (2 weapons) in one answer', async () => {
	const recipe = parseRecipe(professionalFabricator); // quantityRequired 2
	const backpack = [
		{ id: 'w1', def_index: 205, quality: 6, attribute: [] },
		{ id: 'w2', def_index: 210, quality: 6, attribute: [] },
	];

	const assignments = await collectWeaponChoices(recipe, backpack, fakeItemSchema, fakeLang, async () => '0,1');

	assert.deepEqual(assignments, { 2000: ['w1', 'w2'] });
});

test('collectWeaponChoices re-prompts on invalid input (wrong count, out-of-range, or duplicate indices)', async () => {
	const recipe = parseRecipe(professionalFabricator); // quantityRequired 2
	const backpack = [
		{ id: 'w1', def_index: 205, quality: 6, attribute: [] },
		{ id: 'w2', def_index: 210, quality: 6, attribute: [] },
	];

	const answers = ['0', '0,0', '0,99', '0,1']; // too few, duplicate, out of range, then valid
	let call = 0;
	const fakeAsk = async () => answers[call++];

	const assignments = await collectWeaponChoices(recipe, backpack, fakeItemSchema, fakeLang, fakeAsk);

	assert.equal(call, 4);
	assert.deepEqual(assignments, { 2000: ['w1', 'w2'] });
});

test('collectWeaponChoices never calls askFn when there are no candidate weapons - assigns an empty list instead', async () => {
	const recipe = parseRecipe(specializedFabricator1);
	let called = false;
	const assignments = await collectWeaponChoices(recipe, [], fakeItemSchema, fakeLang, async () => {
		called = true;
		return '0';
	});
	assert.equal(called, false);
	assert.deepEqual(assignments, { 2000: [] });
});

test('buildPlan: allSatisfied is false when any input is missing from the backpack', () => {
	const recipe = parseRecipe(specializedFabricator1);
	const backpack = [
		specializedFabricator1,
		{ id: '1', def_index: 5705, quality: 6, quantity: 12 },
		// 5707, 5706, 5702 missing entirely
	];

	const { allSatisfied } = buildPlan(backpack, recipe);
	assert.equal(allSatisfied, false);
});
