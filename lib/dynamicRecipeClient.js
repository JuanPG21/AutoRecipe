'use strict';

const { Language } = require('./gcSchema.js');
const { parseRecipe } = require('./parseRecipe.js');
const { validateAssignments, buildFulfillPayload } = require('./fulfillRecipe.js');

const TF2_APPID = 440;
const DEFAULT_RESPONSE_TIMEOUT_MS = 15000;

function findBackpackItem(backpack, itemId) {
	return (backpack || []).find((item) => String(item.id) === String(itemId));
}

/**
 * Wires dynamic-recipe support onto a live TeamFortress2 instance (from the
 * `tf2` package), without modifying node-tf2 itself - it doesn't implement
 * FulfillDynamicRecipeComponent (see README: jamtat's unmerged 2015 PR,
 * DoctorMcKay/node-tf2#7). Idempotent: safe to call more than once on the
 * same instance.
 *
 * Adds:
 *   tf2.parseDynamicRecipe(toolItemId) -> same shape as parseRecipe()
 *   tf2.fulfillDynamicRecipe(toolItemId, assignments, options?) -> Promise
 *
 * fulfillDynamicRecipe NEVER sends anything if validateAssignments() finds
 * anything missing - it resolves with { sent: false, missing } instead.
 *
 * Response correlation is UNCONFIRMED (see README): this uses steam-user's
 * job-id callback on sendToGC, which is the documented mechanism for
 * request/response GC messages, but no public source confirms TF2's GC
 * actually echoes jobid_target for FulfillDynamicRecipeComponentResponse -
 * node-tf2's own CraftResponse, by contrast, is unsolicited/broadcast, not
 * job-correlated. If the real GC doesn't correlate, the callback will never
 * fire and the call resolves via timeout with acknowledged:false - watch
 * `tf2.on('debug', ...)` during a real test for "Got unhandled GC message
 * FulfillDynamicRecipeComponentResponse" to find out which path is real.
 *
 * @param {import('tf2')} tf2
 */
function attachDynamicRecipeSupport(tf2) {
	if (tf2._dynamicRecipeSupportAttached) {
		return tf2;
	}
	tf2._dynamicRecipeSupportAttached = true;

	tf2.parseDynamicRecipe = function (toolItemId) {
		const toolItem = findBackpackItem(this.backpack, toolItemId);
		if (!toolItem) {
			throw new Error(`parseDynamicRecipe: tool item ${toolItemId} not found in backpack`);
		}
		return parseRecipe(toolItem);
	};

	tf2.fulfillDynamicRecipe = async function (toolItemId, assignments, options = {}) {
		const timeoutMs = options.timeoutMs || DEFAULT_RESPONSE_TIMEOUT_MS;

		const toolItem = findBackpackItem(this.backpack, toolItemId);
		if (!toolItem) {
			throw new Error(`fulfillDynamicRecipe: tool item ${toolItemId} not found in backpack`);
		}

		const recipe = parseRecipe(toolItem);
		const validation = validateAssignments(recipe, assignments, this.backpack);
		if (!validation.ok) {
			return { sent: false, missing: validation.missing, warnings: validation.warnings, recipe };
		}

		const payload = buildFulfillPayload(toolItemId, recipe, assignments);
		const tf2Instance = this;

		return new Promise((resolve) => {
			// Corroborating evidence only, never the primary success signal - the
			// GC's SO cache updates (itemChanged/itemRemoved/itemAcquired) that
			// node-tf2 already emits are independent of whatever the Response
			// message itself turns out to contain.
			const inventoryEvents = [];
			const trackEvent = (type) => (...args) => inventoryEvents.push({ type, at: Date.now(), args });
			const onItemChanged = trackEvent('itemChanged');
			const onItemRemoved = trackEvent('itemRemoved');
			const onItemAcquired = trackEvent('itemAcquired');
			tf2Instance.on('itemChanged', onItemChanged);
			tf2Instance.on('itemRemoved', onItemRemoved);
			tf2Instance.on('itemAcquired', onItemAcquired);

			const cleanup = () => {
				tf2Instance.removeListener('itemChanged', onItemChanged);
				tf2Instance.removeListener('itemRemoved', onItemRemoved);
				tf2Instance.removeListener('itemAcquired', onItemAcquired);
			};

			const finish = (result) => {
				// Emitted in addition to the resolved promise so callers that
				// aren't awaiting this specific call (e.g. a UI layer) can still
				// observe the outcome. NOTE: "acknowledged" only means a response
				// message arrived - it is NOT a confirmed success/fail verdict,
				// because the response payload's schema is unconfirmed (see
				// README). Treat `raw` and `inventoryEvents` as evidence to
				// interpret, not a decoded result.
				tf2Instance.emit('dynamicRecipeFulfillResult', result);
				resolve(result);
			};

			const timer = setTimeout(() => {
				cleanup();
				finish({ sent: true, acknowledged: false, timedOut: true, recipe, warnings: validation.warnings, inventoryEvents });
			}, timeoutMs);

			tf2Instance._steam.sendToGC(TF2_APPID, Language.FulfillDynamicRecipeComponent, {}, payload, (appid, msgType, responsePayload) => {
				clearTimeout(timer);
				cleanup();
				finish({ sent: true, acknowledged: true, timedOut: false, recipe, warnings: validation.warnings, raw: responsePayload, inventoryEvents });
			});
		});
	};

	return tf2;
}

module.exports = { attachDynamicRecipeSupport, TF2_APPID, DEFAULT_RESPONSE_TIMEOUT_MS };
