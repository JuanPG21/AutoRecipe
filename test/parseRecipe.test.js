'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseRecipe, parseAttributesString } = require('../lib/parseRecipe.js');
const {
	specializedFabricator1,
	specializedFabricator2,
	professionalFabricator,
} = require('./fixtures/realFabricators.js');

test('parseAttributesString splits real tokens separated by a doubled control filler between pipes', () => {
	const raw = '2014\x7c\x01\x02\x01\x03\x7c\x01\x02\x01\x03\x7c6.000000\x7c\x01\x02\x01\x03\x7c\x01\x02\x01\x03\x7c2012\x7c\x01\x02\x01\x03\x7c\x01\x02\x01\x03\x7c195.000000';
	assert.deepEqual(parseAttributesString(raw), [
		{ attributeDefIndex: 2014, rawValue: '6.000000' },
		{ attributeDefIndex: 2012, rawValue: '195.000000' },
	]);
});

test('parseAttributesString returns [] for empty/missing strings', () => {
	assert.deepEqual(parseAttributesString(''), []);
	assert.deepEqual(parseAttributesString(undefined), []);
});

test('parseRecipe throws on an item with no recipe slots', () => {
	assert.throws(() => parseRecipe({ id: '1', attribute: [{ def_index: 1, value: 1 }] }), /no dynamic-recipe attributes/);
});

test('parseRecipe throws on an item with no attribute array at all', () => {
	assert.throws(() => parseRecipe({ id: '1' }), /no attribute array/);
});

test('parseRecipe: Specialized Fabricator #1 (real data) - 4 robot part inputs + 1 output', () => {
	const recipe = parseRecipe(specializedFabricator1);

	assert.equal(recipe.toolItemId, '1111111111');
	assert.equal(recipe.toolDefIndex, 20002);

	// Slot 2000 is a weaponChoice: itemDefIndex 0 + killstreak-tier (2025)
	// attribute = a real requirement for 1 freely-chosen weapon (CONFIRMED
	// empirically), not ignorable metadata.
	assert.equal(recipe.attributeSlots.length, 0);
	assert.equal(recipe.weaponChoices.length, 1);
	assert.equal(recipe.weaponChoices[0].attributeIndex, 2000);
	assert.equal(recipe.weaponChoices[0].itemDefIndex, 0);
	assert.equal(recipe.weaponChoices[0].quantityRequired, 1);
	assert.deepEqual(recipe.weaponChoices[0].extraAttributes, [{ attributeDefIndex: 2025, rawValue: '1' }]);

	assert.equal(recipe.inputs.length, 4);
	assert.deepEqual(
		recipe.inputs.map((s) => ({ attributeIndex: s.attributeIndex, itemDefIndex: s.itemDefIndex, quantityRequired: s.quantityRequired, quality: s.quality })),
		[
			{ attributeIndex: 2001, itemDefIndex: 5705, quantityRequired: 12, quality: 6 },
			{ attributeIndex: 2002, itemDefIndex: 5707, quantityRequired: 9, quality: 6 },
			{ attributeIndex: 2003, itemDefIndex: 5706, quantityRequired: 3, quality: 6 },
			{ attributeIndex: 2004, itemDefIndex: 5702, quantityRequired: 5, quality: 6 },
		]
	);

	assert.equal(recipe.output.attributeIndex, 2005);
	assert.equal(recipe.output.itemDefIndex, 6523);
	assert.equal(recipe.output.quantityRequired, 1);
	assert.deepEqual(recipe.output.extraAttributes, [
		{ attributeDefIndex: 2014, rawValue: '6.000000' },
		{ attributeDefIndex: 2012, rawValue: '195.000000' },
	]);

	// Every real input requires all 0 fulfilled so far (fresh, unfulfilled fabricator)
	recipe.inputs.forEach((s) => assert.equal(s.quantityFulfilled, 0));
});

test('parseRecipe: Specialized Fabricator #2 (real data) - 6 robot part inputs + 1 output', () => {
	const recipe = parseRecipe(specializedFabricator2);

	assert.equal(recipe.inputs.length, 6);
	assert.equal(recipe.attributeSlots.length, 0);
	assert.equal(recipe.weaponChoices.length, 1);
	assert.equal(recipe.weaponChoices[0].quantityRequired, 1);
	assert.equal(recipe.output.attributeIndex, 2007);
	assert.equal(recipe.output.itemDefIndex, 6523);

	const total = recipe.inputs.reduce((sum, s) => sum + s.quantityRequired, 0);
	assert.equal(total, 13 + 4 + 7 + 2 + 2 + 1);
});

test('parseRecipe: Professional Fabricator (real data) - 5 robot part inputs (2 rare) + 1 output with 3 preset attrs', () => {
	const recipe = parseRecipe(professionalFabricator);

	assert.equal(recipe.toolDefIndex, 20003);
	assert.equal(recipe.inputs.length, 5);

	// slot 2000's killstreak-tier value is 2 for Professional vs 1 for Specialized -
	// i.e. this Fabricator needs 2 freely-chosen weapons, not 1
	assert.equal(recipe.weaponChoices.length, 1);
	assert.equal(recipe.weaponChoices[0].quantityRequired, 2);
	assert.deepEqual(recipe.weaponChoices[0].extraAttributes, [{ attributeDefIndex: 2025, rawValue: '2' }]);

	// The two rarest robot part slots (5701, 5700) carry a loot_rarity (2022) requirement
	const rareSlots = recipe.inputs.filter((s) => s.extraAttributes.length > 0);
	assert.equal(rareSlots.length, 2);
	rareSlots.forEach((s) => {
		assert.deepEqual(s.extraAttributes, [{ attributeDefIndex: 2022, rawValue: '1065353216' }]);
	});

	// Output carries sheen (2014) + killstreaker (2013) + tool target item (2012) - 3 pairs, unlike Specialized's 2
	assert.equal(recipe.output.itemDefIndex, 6526);
	assert.equal(recipe.output.extraAttributes.length, 3);
	assert.deepEqual(
		recipe.output.extraAttributes.map((a) => a.attributeDefIndex),
		[2014, 2013, 2012]
	);
});

test('parseRecipe: slots array is the union of inputs + weaponChoices + attributeSlots + output, sorted by attributeIndex', () => {
	const recipe = parseRecipe(professionalFabricator);
	assert.equal(recipe.slots.length, recipe.inputs.length + recipe.weaponChoices.length + recipe.attributeSlots.length + 1);
	for (let i = 1; i < recipe.slots.length; i++) {
		assert.ok(recipe.slots[i].attributeIndex > recipe.slots[i - 1].attributeIndex);
	}
});

test('parseRecipe: an itemDefIndex-0 slot WITHOUT the killstreak-tier attribute falls back to kind "attribute", not weaponChoice', () => {
	// Synthetic - no real sample of this shape has been seen, but the
	// classification must not assume every itemdef-0 slot is a weapon choice.
	const { Schema } = require('../lib/gcSchema.js');
	const syntheticBytes = Buffer.from(
		Schema.CAttribute_DynamicRecipeComponent.encode(
			Schema.CAttribute_DynamicRecipeComponent.create({ def_index: 0, item_quality: 6, num_required: 1, attributes_string: '' })
		).finish()
	);
	const item = {
		...specializedFabricator1,
		attribute: specializedFabricator1.attribute.map((a) => (a.def_index === 2000 ? { def_index: 2000, value_bytes: syntheticBytes } : a)),
	};

	const recipe = parseRecipe(item);
	assert.equal(recipe.weaponChoices.length, 0);
	assert.equal(recipe.attributeSlots.length, 1);
	assert.equal(recipe.attributeSlots[0].attributeIndex, 2000);
});
