'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
	ROBOT_PART_DEFINDEXES,
	ADJACENT_NON_ROBOT_PART_DEFINDEXES,
	KIT_DEFINDEXES,
	humanizeInternalName,
	resolveDisplayName,
	buildTable,
} = require('../scripts/robot-part-names.js');

// Small synthetic schema/lang covering one item per interesting case - NOT
// the real 7MB items_game.txt (that's only fetched at runtime by main()).
const fakeItemSchema = {
	items: {
		5700: { name: 'Robits Loot 01', item_name: '#TF_Item_Robits_Loot_01' },
		5708: { name: 'Fall 2013 Acorns Crate', item_name: '#TF_Fall2013Crate_Acorns' },
		6523: { name: 'Killstreakifier', item_name: '#TF_KillStreakifier_Name' },
		9999: { name: 'TF_WEAPON_NO_LANG_TOKEN' }, // no item_name - exercises humanized fallback
	},
};
const fakeLang = {
	TF_Item_Robits_Loot_01: 'Pristine Robot Currency Digester',
	TF_Fall2013Crate_Acorns: 'Fall 2013 Acorns Crate',
	TF_KillStreakifier_Name: 'Kit',
};

test('ROBOT_PART_DEFINDEXES is exactly the 5700-5707 range (8 items), excluding 5708/5709', () => {
	assert.deepEqual(ROBOT_PART_DEFINDEXES, [5700, 5701, 5702, 5703, 5704, 5705, 5706, 5707]);
	assert.equal(ROBOT_PART_DEFINDEXES.includes(5708), false);
	assert.equal(ROBOT_PART_DEFINDEXES.includes(5709), false);
});

test('ADJACENT_NON_ROBOT_PART_DEFINDEXES and KIT_DEFINDEXES match what the README/parseRecipe reference', () => {
	assert.deepEqual(ADJACENT_NON_ROBOT_PART_DEFINDEXES, [5708, 5709]);
	assert.deepEqual(KIT_DEFINDEXES, [6523, 6526]);
});

test('humanizeInternalName turns an internal dev name into something readable', () => {
	assert.equal(humanizeInternalName('TF_WEAPON_NO_LANG_TOKEN'), 'No Lang Token');
	assert.equal(humanizeInternalName(null), null);
});

test('resolveDisplayName prefers the real localized name over the internal dev name', () => {
	assert.equal(resolveDisplayName(5700, fakeItemSchema, fakeLang), 'Pristine Robot Currency Digester');
});

test('resolveDisplayName falls back to a humanized internal name when there is no lang token', () => {
	assert.equal(resolveDisplayName(9999, fakeItemSchema, fakeLang), 'No Lang Token');
});

test('resolveDisplayName falls back to a bare defindex when the item is unknown to the schema', () => {
	assert.equal(resolveDisplayName(123456, fakeItemSchema, fakeLang), 'defindex 123456');
});

test('buildTable: robot part rows carry no note', () => {
	const rows = buildTable(fakeItemSchema, fakeLang);
	const row5700 = rows.find((r) => r.defIndex === 5700);
	assert.equal(row5700.name, 'Pristine Robot Currency Digester');
	assert.equal(row5700.note, '');
});

test('buildTable: flags 5708/5709 as NOT robot parts instead of silently including or dropping them', () => {
	const rows = buildTable(fakeItemSchema, fakeLang);
	const row5708 = rows.find((r) => r.defIndex === 5708);
	assert.equal(row5708.name, 'Fall 2013 Acorns Crate');
	assert.match(row5708.note, /NOT a robot part/);
});

test('buildTable: flags kit defindexes as generic placeholder names, not usable as-is for market search', () => {
	const rows = buildTable(fakeItemSchema, fakeLang);
	const row6523 = rows.find((r) => r.defIndex === 6523);
	assert.equal(row6523.name, 'Kit');
	assert.match(row6523.note, /generic placeholder/);
});

test('buildTable: contains exactly ROBOT_PART + ADJACENT + KIT defindexes, in that order', () => {
	const rows = buildTable(fakeItemSchema, fakeLang);
	assert.deepEqual(
		rows.map((r) => r.defIndex),
		[...ROBOT_PART_DEFINDEXES, ...ADJACENT_NON_ROBOT_PART_DEFINDEXES, ...KIT_DEFINDEXES]
	);
});
