'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('node:events');

const { attachDynamicRecipeSupport, TF2_APPID } = require('../lib/dynamicRecipeClient.js');
const { Language, Schema } = require('../lib/gcSchema.js');
const { specializedFabricator1 } = require('./fixtures/realFabricators.js');

function makeFakeTf2(backpack) {
	const tf2 = new EventEmitter();
	tf2.backpack = backpack;
	tf2.sentToGC = [];
	tf2._steam = {
		sendToGC(appid, msgType, header, payload, callback) {
			tf2.sentToGC.push({ appid, msgType, header, payload, callback });
		},
	};
	return tf2;
}

function fullBackpack() {
	return [
		specializedFabricator1,
		// Stand-in weapon for slot 2000 (weaponChoice) - see README, not
		// validated for kit-tier, only that it exists.
		{ id: '5', def_index: 205, quality: 6, quantity: 1 },
		{ id: '1', def_index: 5705, quality: 6, quantity: 12 },
		{ id: '2', def_index: 5707, quality: 6, quantity: 9 },
		{ id: '3', def_index: 5706, quality: 6, quantity: 3 },
		{ id: '4', def_index: 5702, quality: 6, quantity: 5 },
	];
}

const fullAssignments = { 2000: '5', 2001: '1', 2002: '2', 2003: '3', 2004: '4' };

test('attachDynamicRecipeSupport is idempotent', () => {
	const tf2 = makeFakeTf2([]);
	attachDynamicRecipeSupport(tf2);
	const fn = tf2.fulfillDynamicRecipe;
	attachDynamicRecipeSupport(tf2);
	assert.equal(tf2.fulfillDynamicRecipe, fn);
});

test('parseDynamicRecipe throws for a tool item not in the backpack', () => {
	const tf2 = makeFakeTf2([]);
	attachDynamicRecipeSupport(tf2);
	assert.throws(() => tf2.parseDynamicRecipe('does-not-exist'), /not found in backpack/);
});

test('parseDynamicRecipe parses a real tool item found in the backpack', () => {
	const tf2 = makeFakeTf2(fullBackpack());
	attachDynamicRecipeSupport(tf2);
	const recipe = tf2.parseDynamicRecipe(specializedFabricator1.id);
	assert.equal(recipe.inputs.length, 4);
});

test('fulfillDynamicRecipe rejects for a tool item not in the backpack', async () => {
	const tf2 = makeFakeTf2([]);
	attachDynamicRecipeSupport(tf2);
	await assert.rejects(() => tf2.fulfillDynamicRecipe('does-not-exist', {}), /not found in backpack/);
});

test('fulfillDynamicRecipe does not call sendToGC and reports missing items when validation fails', async () => {
	const tf2 = makeFakeTf2(fullBackpack());
	attachDynamicRecipeSupport(tf2);

	const result = await tf2.fulfillDynamicRecipe(specializedFabricator1.id, { 2000: '5', 2001: '1', 2002: '2', 2003: '3' /* 2004 missing */ });

	assert.equal(result.sent, false);
	assert.equal(result.missing.length, 1);
	assert.equal(result.missing[0].attributeIndex, 2004);
	assert.equal(tf2.sentToGC.length, 0);
});

test('fulfillDynamicRecipe sends a correctly-encoded payload and resolves when the GC job callback fires', async () => {
	const tf2 = makeFakeTf2(fullBackpack());
	attachDynamicRecipeSupport(tf2);

	const resultPromise = tf2.fulfillDynamicRecipe(specializedFabricator1.id, fullAssignments);

	// Let the microtask queue advance so sendToGC has been called.
	await new Promise((r) => setImmediate(r));
	assert.equal(tf2.sentToGC.length, 1);

	const sent = tf2.sentToGC[0];
	assert.equal(sent.appid, TF2_APPID);
	assert.equal(sent.msgType, Language.FulfillDynamicRecipeComponent);
	assert.deepEqual(sent.header, {});

	const decoded = Schema.CMsgFulfillDynamicRecipeComponent.toObject(Schema.CMsgFulfillDynamicRecipeComponent.decode(sent.payload), { longs: String });
	assert.equal(decoded.tool_item_id, specializedFabricator1.id);
	assert.equal(decoded.consumption_components.length, 5);

	// Simulate the GC replying via the job-id callback.
	sent.callback(TF2_APPID, Language.FulfillDynamicRecipeComponentResponse, Buffer.from('fake-response'));

	const result = await resultPromise;
	assert.equal(result.sent, true);
	assert.equal(result.acknowledged, true);
	assert.equal(result.timedOut, false);
	assert.deepEqual(result.raw, Buffer.from('fake-response'));
	assert.equal(result.warnings.length, 1);
	assert.equal(result.warnings[0].attributeIndex, 2000);
});

test('fulfillDynamicRecipe resolves via timeout when the GC never responds', async () => {
	const tf2 = makeFakeTf2(fullBackpack());
	attachDynamicRecipeSupport(tf2);

	const result = await tf2.fulfillDynamicRecipe(specializedFabricator1.id, fullAssignments, { timeoutMs: 20 });

	assert.equal(result.sent, true);
	assert.equal(result.acknowledged, false);
	assert.equal(result.timedOut, true);
});

test('fulfillDynamicRecipe emits dynamicRecipeFulfillResult with the same result it resolves', async () => {
	const tf2 = makeFakeTf2(fullBackpack());
	attachDynamicRecipeSupport(tf2);

	let emitted = null;
	tf2.on('dynamicRecipeFulfillResult', (result) => {
		emitted = result;
	});

	const resultPromise = tf2.fulfillDynamicRecipe(specializedFabricator1.id, fullAssignments, { timeoutMs: 20 });
	const result = await resultPromise;

	assert.equal(result.timedOut, true);
	assert.equal(emitted, result);
});

test('fulfillDynamicRecipe collects inventory events observed while waiting for a response', async () => {
	const tf2 = makeFakeTf2(fullBackpack());
	attachDynamicRecipeSupport(tf2);

	const resultPromise = tf2.fulfillDynamicRecipe(specializedFabricator1.id, fullAssignments);
	await new Promise((r) => setImmediate(r));

	tf2.emit('itemRemoved', { id: '1' });
	tf2.emit('itemAcquired', { id: '999' });

	tf2.sentToGC[0].callback(TF2_APPID, Language.FulfillDynamicRecipeComponentResponse, Buffer.alloc(0));

	const result = await resultPromise;
	assert.equal(result.inventoryEvents.length, 2);
	assert.deepEqual(result.inventoryEvents.map((e) => e.type), ['itemRemoved', 'itemAcquired']);
});
