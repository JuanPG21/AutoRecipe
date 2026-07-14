'use strict';

const { Schema } = require('./gcSchema.js');

// Dynamic-recipe component slots live at item attribute defindex 2000-2009
// ("recipe component defined item 1".."10" in items_game.txt's attribute schema).
const SLOT_MIN = 2000;
const SLOT_MAX = 2009;

// Confirmed by byte-level inspection of real value_bytes pulled from a live
// backpack: attributes_string is a sequence of real tokens separated by pipe
// (0x7c) characters, where every gap between two real tokens contains this
// exact 4-byte control filler TWICE (i.e. real tokens are found at every
// other position when split on a single "|"; splitting naively on a longer
// substring guess mis-parses odd-numbered-pair strings - see git history of
// this file / the test that caught it).
const ATTR_STRING_FILLER = '\x01\x02\x01\x03';

// "killstreak tier" in items_game.txt's attribute schema. CONFIRMED empirically
// (real craft attempt) that a slot with itemDefIndex 0 carrying this attribute
// is a real requirement, not ignorable metadata: it means the recipe consumes
// N freely-chosen weapons (quantity = the slot's own num_required, which always
// matched this attribute's value in every sample seen), gated by a kit-tier
// precondition on those weapons that this library does NOT validate - see
// README ("weapon requirement" / WEAPON_REQUIREMENT_BY_TOOL_DEFINDEX in
// scripts/fulfill-recipe.js).
const KILLSTREAK_TIER_ATTRIBUTE_DEFINDEX = 2025;

/**
 * Splits a CAttribute_DynamicRecipeComponent.attributes_string into its
 * (attributeDefIndex, rawValue) pairs. rawValue is returned as the raw string
 * token exactly as the GC sent it (e.g. "6.000000" or "1065353216") - NOT
 * normalized to a JS number, because the encoding is inconsistent: some
 * attributes appear as plain decimal, others as the decimal text of the
 * attribute's raw float32 bit pattern (unconfirmed which is which in general -
 * see README). Callers that need the semantic value must interpret rawValue
 * themselves against the attribute's known type.
 */
function parseAttributesString(attributesString) {
	if (!attributesString) {
		return [];
	}

	const tokens = attributesString.split('\x7c').filter((t) => t.length > 0 && t !== ATTR_STRING_FILLER);
	const pairs = [];
	for (let i = 0; i + 1 < tokens.length; i += 2) {
		pairs.push({ attributeDefIndex: Number(tokens[i]), rawValue: tokens[i + 1] });
	}
	return pairs;
}

/**
 * Parses a dynamic recipe tool item (Killstreak Kit Fabricator - verified;
 * Chemistry Set - theoretical, see README) into its component slots.
 *
 * There is no explicit is_output flag on the wire. Classification is inferred
 * from three real Fabricators (see test/fixtures/realFabricators.js):
 *   - the highest-numbered slot (attributeIndex) present is always the output
 *   - a slot whose required itemDefIndex is 0 AND carries the "killstreak
 *     tier" attribute (2025) is a weaponChoice slot: CONFIRMED empirically to
 *     require quantityRequired freely-chosen weapons as real input, sent the
 *     same way as any other component (attribute_index = this slot,
 *     subject_item_id = the chosen weapon's item id). Which weapon qualifies
 *     is NOT validated here - see README.
 *   - any other slot with itemDefIndex 0 (none seen yet) falls back to kind
 *     'attribute': surfaced but never treated as something to fulfill, since
 *     its purpose isn't confirmed
 *   - everything else is a real item input
 *
 * @param {object} item - a backpack item (CSOEconItem-shaped: {id, def_index, attribute: [{def_index, value_bytes}]})
 * @returns {{toolItemId: string, toolDefIndex: number, slots: object[], inputs: object[], weaponChoices: object[], output: object, attributeSlots: object[]}}
 */
function parseRecipe(item) {
	if (!item || !Array.isArray(item.attribute)) {
		throw new Error('parseRecipe: item has no attribute array - not a valid backpack item');
	}

	const slotAttrs = item.attribute.filter((a) => a.def_index >= SLOT_MIN && a.def_index <= SLOT_MAX);
	if (slotAttrs.length === 0) {
		throw new Error(`parseRecipe: item ${item.id} has no dynamic-recipe attributes (defindex ${SLOT_MIN}-${SLOT_MAX}); it is not a dynamic recipe tool`);
	}

	const decodedSlots = slotAttrs
		.map((a) => {
			if (!a.value_bytes || !a.value_bytes.length) {
				throw new Error(`parseRecipe: slot ${a.def_index} on item ${item.id} has no value_bytes to decode`);
			}
			const decoded = Schema.CAttribute_DynamicRecipeComponent.decode(a.value_bytes);
			return {
				attributeIndex: a.def_index,
				itemDefIndex: decoded.def_index,
				quality: decoded.item_quality,
				componentFlags: decoded.component_flags,
				quantityRequired: decoded.num_required,
				quantityFulfilled: decoded.num_fulfilled,
				extraAttributes: parseAttributesString(decoded.attributes_string),
			};
		})
		.sort((a, b) => a.attributeIndex - b.attributeIndex);

	const output = { ...decodedSlots[decodedSlots.length - 1], kind: 'output' };

	const inputs = [];
	const weaponChoices = [];
	const attributeSlots = [];
	for (const slot of decodedSlots.slice(0, -1)) {
		if (slot.itemDefIndex === 0) {
			const isWeaponChoice = slot.extraAttributes.some((a) => a.attributeDefIndex === KILLSTREAK_TIER_ATTRIBUTE_DEFINDEX);
			if (isWeaponChoice) {
				weaponChoices.push({ ...slot, kind: 'weaponChoice' });
			} else {
				attributeSlots.push({ ...slot, kind: 'attribute' });
			}
		} else {
			inputs.push({ ...slot, kind: 'input' });
		}
	}

	const slots = [...inputs, ...weaponChoices, ...attributeSlots, output].sort((a, b) => a.attributeIndex - b.attributeIndex);

	return {
		toolItemId: item.id,
		toolDefIndex: item.def_index,
		slots,
		inputs,
		weaponChoices,
		output,
		attributeSlots,
	};
}

module.exports = { parseRecipe, parseAttributesString, SLOT_MIN, SLOT_MAX, ATTR_STRING_FILLER, KILLSTREAK_TIER_ATTRIBUTE_DEFINDEX };
