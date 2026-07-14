'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseRecipe } = require('../lib/parseRecipe.js');
const { validateAssignments, buildFulfillPayload } = require('../lib/fulfillRecipe.js');
const { Schema } = require('../lib/gcSchema.js');
const { specializedFabricator1 } = require('./fixtures/realFabricators.js');

// Specialized Fabricator #1 needs (from the real dump):
//   2000: 1 freely-chosen weapon (weaponChoice - CONFIRMED empirically, see README)
//   2001: itemdef 5705 x12, quality 6
//   2002: itemdef 5707 x9,  quality 6
//   2003: itemdef 5706 x3,  quality 6
//   2004: itemdef 5702 x5,  quality 6
const recipe = parseRecipe(specializedFabricator1);

const WEAPON_SLOT_WARNING = {
	attributeIndex: 2000,
	kind: 'weaponChoice',
	message: 'slot 2000: the kit-tier precondition on the 1 chosen weapon(s) is NOT validated by this library - verify manually (see README)',
};

function fullBackpack() {
	return [
		specializedFabricator1,
		// Stand-in for "some Unique weapon with a normal Killstreak Kit already
		// applied" - validateAssignments cannot and does not check that
		// precondition, only that the id exists (see README).
		{ id: '5', def_index: 205, quality: 6, quantity: 1 },
		{ id: '1', def_index: 5705, quality: 6, quantity: 12 },
		{ id: '2', def_index: 5707, quality: 6, quantity: 9 },
		{ id: '3', def_index: 5706, quality: 6, quantity: 3 },
		{ id: '4', def_index: 5702, quality: 6, quantity: 5 },
	];
}

function fullAssignments() {
	return { 2000: '5', 2001: '1', 2002: '2', 2003: '3', 2004: '4' };
}

test('validateAssignments: ok when every slot has a matching, sufficient item, plus a weaponChoice warning', () => {
	const result = validateAssignments(recipe, fullAssignments(), fullBackpack());
	assert.deepEqual(result, { ok: true, missing: [], warnings: [WEAPON_SLOT_WARNING] });
});

test('validateAssignments: reports a missing slot when no assignment is given', () => {
	const assignments = fullAssignments();
	delete assignments[2003];
	const result = validateAssignments(recipe, assignments, fullBackpack());
	assert.equal(result.ok, false);
	assert.equal(result.missing.length, 1);
	assert.equal(result.missing[0].attributeIndex, 2003);
	assert.match(result.missing[0].reason, /no item assigned/);
});

test('validateAssignments: reports when the assigned item id does not exist in backpack', () => {
	const assignments = { ...fullAssignments(), 2001: '999' };
	const result = validateAssignments(recipe, assignments, fullBackpack());
	assert.equal(result.ok, false);
	assert.equal(result.missing[0].reason, 'item 999 not found in backpack');
});

test('validateAssignments: reports when the assigned item is the wrong defindex/quality', () => {
	const backpack = fullBackpack();
	backpack.push({ id: '6', def_index: 9999, quality: 6, quantity: 99 });
	const assignments = { ...fullAssignments(), 2002: '6' };
	const result = validateAssignments(recipe, assignments, backpack);
	assert.equal(result.ok, false);
	assert.match(result.missing[0].reason, /defindex 9999/);
});

test('validateAssignments: reports when quantity is insufficient', () => {
	const backpack = fullBackpack();
	backpack.find((i) => i.id === '1').quantity = 5; // only 5 of the 12 required 5705s
	const result = validateAssignments(recipe, fullAssignments(), backpack);
	assert.equal(result.ok, false);
	assert.equal(result.missing[0].attributeIndex, 2001);
	assert.match(result.missing[0].reason, /only 5 of 12/);
});

test('validateAssignments: sums quantity across multiple item ids assigned to the same slot', () => {
	const backpack = fullBackpack();
	backpack.find((i) => i.id === '1').quantity = 7; // split the 5705 requirement across two stacks: 7 + 5 = 12
	backpack.push({ id: '11', def_index: 5705, quality: 6, quantity: 5 });
	const assignments = { ...fullAssignments(), 2001: ['1', '11'] };
	const result = validateAssignments(recipe, assignments, backpack);
	assert.deepEqual(result, { ok: true, missing: [], warnings: [WEAPON_SLOT_WARNING] });
});

test('validateAssignments: reports every missing slot, not just the first', () => {
	const result = validateAssignments(recipe, {}, fullBackpack());
	assert.equal(result.missing.length, 5); // 1 weaponChoice + 4 inputs
});

test('validateAssignments: weaponChoice slot missing entirely counts as a missing slot, not just a warning', () => {
	const assignments = fullAssignments();
	delete assignments[2000];
	const result = validateAssignments(recipe, assignments, fullBackpack());
	assert.equal(result.ok, false);
	const weaponMissing = result.missing.find((m) => m.attributeIndex === 2000);
	assert.ok(weaponMissing);
	assert.equal(weaponMissing.kind, 'weaponChoice');
	assert.match(weaponMissing.reason, /expected exactly 1 weapon/);
	// No warning is issued for a slot that failed validation
	assert.equal(result.warnings.length, 0);
});

test('validateAssignments: weaponChoice slot with the wrong number of ids is reported as missing', () => {
	const assignments = { ...fullAssignments(), 2000: ['5', '1'] };
	const result = validateAssignments(recipe, assignments, fullBackpack());
	assert.equal(result.ok, false);
	assert.match(result.missing[0].reason, /expected exactly 1 weapon item id\(s\), got 2/);
});

test('validateAssignments: weaponChoice slot pointing at a nonexistent item id is reported as missing', () => {
	const assignments = { ...fullAssignments(), 2000: '999999' };
	const result = validateAssignments(recipe, assignments, fullBackpack());
	assert.equal(result.ok, false);
	assert.match(result.missing[0].reason, /not found in backpack: 999999/);
});

test('validateAssignments: weaponChoice slot does NOT check itemdef/quality (any weapon id that exists passes)', () => {
	const backpack = fullBackpack();
	backpack.push({ id: '7', def_index: 1, quality: 3, quantity: 1 }); // deliberately unrelated defindex/quality
	const result = validateAssignments(recipe, { ...fullAssignments(), 2000: '7' }, backpack);
	assert.equal(result.ok, true);
});

test('buildFulfillPayload: encodes one CMsgRecipeComponent per assigned item id (including the weaponChoice slot), round-trips correctly', () => {
	const payload = buildFulfillPayload(specializedFabricator1.id, recipe, fullAssignments());
	assert.ok(Buffer.isBuffer(payload));

	const decoded = Schema.CMsgFulfillDynamicRecipeComponent.decode(payload);
	const obj = Schema.CMsgFulfillDynamicRecipeComponent.toObject(decoded, { longs: String });

	assert.equal(obj.tool_item_id, specializedFabricator1.id);
	assert.equal(obj.consumption_components.length, 5);
	assert.deepEqual(
		obj.consumption_components.map((c) => ({ subject_item_id: c.subject_item_id, attribute_index: c.attribute_index })),
		[
			{ subject_item_id: '5', attribute_index: '2000' },
			{ subject_item_id: '1', attribute_index: '2001' },
			{ subject_item_id: '2', attribute_index: '2002' },
			{ subject_item_id: '3', attribute_index: '2003' },
			{ subject_item_id: '4', attribute_index: '2004' },
		]
	);
});

test('buildFulfillPayload: emits one component entry per item id when a slot has multiple ids assigned', () => {
	const assignments = { ...fullAssignments(), 2001: ['1', '11'] };
	const payload = buildFulfillPayload(specializedFabricator1.id, recipe, assignments);
	const obj = Schema.CMsgFulfillDynamicRecipeComponent.toObject(Schema.CMsgFulfillDynamicRecipeComponent.decode(payload), { longs: String });
	const slot2001Entries = obj.consumption_components.filter((c) => c.attribute_index === '2001');
	assert.equal(slot2001Entries.length, 2);
	assert.deepEqual(slot2001Entries.map((c) => c.subject_item_id), ['1', '11']);
});

test('buildFulfillPayload: emits a component with attribute_index 2000 for the weaponChoice slot', () => {
	const payload = buildFulfillPayload(specializedFabricator1.id, recipe, fullAssignments());
	const obj = Schema.CMsgFulfillDynamicRecipeComponent.toObject(Schema.CMsgFulfillDynamicRecipeComponent.decode(payload), { longs: String });
	const weaponEntry = obj.consumption_components.find((c) => c.attribute_index === '2000');
	assert.deepEqual(weaponEntry, { subject_item_id: '5', attribute_index: '2000' });
});
