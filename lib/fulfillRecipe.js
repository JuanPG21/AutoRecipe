'use strict';

const { Schema } = require('./gcSchema.js');

/**
 * Checks that every input slot in a parsed recipe has a matching, available
 * backpack item assigned to it. Never mutates anything and never sends
 * anything - this is pure validation so it can run (and be tested) with no
 * live GC connection.
 *
 * weaponChoice slots (see parseRecipe) are validated differently from regular
 * inputs: any weapon works structurally (no itemDefIndex to match against -
 * it's 0, meaning "caller's free choice"), so this only checks that exactly
 * quantityRequired ids were given and that each exists in the backpack. It
 * canNOT check the kit-tier precondition those weapons must meet (README) -
 * a warning is returned instead so callers can surface it to a human.
 *
 * @param {object} recipe - result of parseRecipe()
 * @param {object} assignments - { [attributeIndex]: itemId | itemId[] }
 * @param {object[]} backpack - array of backpack items (id, def_index, quality, quantity)
 * @returns {{ok: boolean, missing: object[], warnings: object[]}}
 */
function validateAssignments(recipe, assignments, backpack) {
	const byId = new Map((backpack || []).map((item) => [String(item.id), item]));
	const missing = [];
	const warnings = [];

	for (const slot of recipe.inputs) {
		const raw = assignments ? assignments[slot.attributeIndex] : undefined;

		if (raw === undefined || raw === null || (Array.isArray(raw) && raw.length === 0)) {
			missing.push({
				attributeIndex: slot.attributeIndex,
				kind: 'input',
				itemDefIndex: slot.itemDefIndex,
				quality: slot.quality,
				quantityRequired: slot.quantityRequired,
				reason: 'no item assigned to this slot',
			});
			continue;
		}

		const ids = Array.isArray(raw) ? raw : [raw];
		let availableQuantity = 0;
		let badMatch = null;

		for (const id of ids) {
			const item = byId.get(String(id));
			if (!item) {
				badMatch = `item ${id} not found in backpack`;
				break;
			}
			if (item.def_index !== slot.itemDefIndex || item.quality !== slot.quality) {
				badMatch = `item ${id} is defindex ${item.def_index} quality ${item.quality}, slot ${slot.attributeIndex} needs defindex ${slot.itemDefIndex} quality ${slot.quality}`;
				break;
			}
			availableQuantity += item.quantity || 1;
		}

		if (badMatch) {
			missing.push({
				attributeIndex: slot.attributeIndex,
				kind: 'input',
				itemDefIndex: slot.itemDefIndex,
				quality: slot.quality,
				quantityRequired: slot.quantityRequired,
				reason: badMatch,
			});
			continue;
		}

		if (availableQuantity < slot.quantityRequired) {
			missing.push({
				attributeIndex: slot.attributeIndex,
				kind: 'input',
				itemDefIndex: slot.itemDefIndex,
				quality: slot.quality,
				quantityRequired: slot.quantityRequired,
				reason: `only ${availableQuantity} of ${slot.quantityRequired} required units available`,
			});
		}
	}

	for (const slot of recipe.weaponChoices || []) {
		const raw = assignments ? assignments[slot.attributeIndex] : undefined;
		const ids = raw === undefined || raw === null ? [] : Array.isArray(raw) ? raw : [raw];

		if (ids.length !== slot.quantityRequired) {
			missing.push({
				attributeIndex: slot.attributeIndex,
				kind: 'weaponChoice',
				quantityRequired: slot.quantityRequired,
				reason: `expected exactly ${slot.quantityRequired} weapon item id(s), got ${ids.length}`,
			});
			continue;
		}

		const notFound = ids.filter((id) => !byId.has(String(id)));
		if (notFound.length > 0) {
			missing.push({
				attributeIndex: slot.attributeIndex,
				kind: 'weaponChoice',
				quantityRequired: slot.quantityRequired,
				reason: `item(s) not found in backpack: ${notFound.join(', ')}`,
			});
			continue;
		}

		warnings.push({
			attributeIndex: slot.attributeIndex,
			kind: 'weaponChoice',
			message: `slot ${slot.attributeIndex}: the kit-tier precondition on the ${slot.quantityRequired} chosen weapon(s) is NOT validated by this library - verify manually (see README)`,
		});
	}

	return { ok: missing.length === 0, missing, warnings };
}

/**
 * Encodes a CMsgFulfillDynamicRecipeComponent for the given tool + assignments.
 * Caller must have already validated with validateAssignments() - this does
 * not re-check the backpack, it just builds the wire payload.
 *
 * One CMsgRecipeComponent is emitted per assigned item id (not per required
 * unit): if a slot needing 13 units is satisfied by a single stacked backpack
 * item, exactly one component entry is sent for that slot. Whether the real
 * GC expects bulk-stack consumption like this, or one repeated entry per
 * unit, is UNCONFIRMED - see README. weaponChoice slots (attribute_index
 * 2000 in every sample seen) are included the same way, one component per
 * chosen weapon id - CONFIRMED necessary, see parseRecipe.
 *
 * @param {string|number} toolItemId
 * @param {object} recipe - result of parseRecipe()
 * @param {object} assignments - { [attributeIndex]: itemId | itemId[] }
 * @returns {Buffer}
 */
function buildFulfillPayload(toolItemId, recipe, assignments) {
	const consumption_components = [];

	const fulfillableSlots = [...recipe.inputs, ...(recipe.weaponChoices || [])].sort((a, b) => a.attributeIndex - b.attributeIndex);

	for (const slot of fulfillableSlots) {
		const raw = assignments[slot.attributeIndex];
		const ids = Array.isArray(raw) ? raw : [raw];
		for (const id of ids) {
			consumption_components.push({ subject_item_id: id, attribute_index: slot.attributeIndex });
		}
	}

	const message = Schema.CMsgFulfillDynamicRecipeComponent.create({
		tool_item_id: toolItemId,
		consumption_components,
	});

	return Buffer.from(Schema.CMsgFulfillDynamicRecipeComponent.encode(message).finish());
}

module.exports = { validateAssignments, buildFulfillPayload };
