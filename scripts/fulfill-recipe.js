'use strict';

/**
 * Interactive live-test harness for fulfillDynamicRecipe. Connects to Steam/TF2,
 * lets you pick a dynamic recipe item from your backpack, auto-matches
 * required components from your inventory, shows you the full plan, and
 * requires typed confirmation before it sends anything - this consumes real
 * items and cannot be undone.
 *
 * Usage:
 *   node scripts/fulfill-recipe.js            interactive, will ask to confirm before sending
 *   node scripts/fulfill-recipe.js --dry-run   parses + plans + validates, never sends, no confirm needed
 *
 * Credentials: STEAM_USERNAME / STEAM_PASSWORD env vars, or you'll be prompted.
 */

const readline = require('readline');
const https = require('https');
const VDF = require('kvparser');
const SteamUser = require('steam-user');
const TeamFortress2 = require('tf2');
const { attachDynamicRecipeSupport } = require('../lib/dynamicRecipeClient.js');
const { parseRecipe, SLOT_MIN, SLOT_MAX, KILLSTREAK_TIER_ATTRIBUTE_DEFINDEX } = require('../lib/parseRecipe.js');
const { validateAssignments } = require('../lib/fulfillRecipe.js');
const { robotPartName } = require('../lib/robotPartCatalog.js');

const DRY_RUN = process.argv.includes('--dry-run');
const CONFIRM_PHRASE = 'CONFIRMAR';
const UNIQUE_QUALITY = 6;

// Killstreak kits only apply to actual combat weapons - confirmed item_slot
// values for those in items_game.txt (as opposed to head/misc cosmetics,
// action items, PDAs, buildings, etc).
const WEAPON_ITEM_SLOTS = new Set(['primary', 'secondary', 'melee']);

// Unofficial mirror of Valve's TF2 lang file, used ONLY to resolve item
// defindex -> human-readable weapon name for the weapon-picker prompt. Not
// authoritative, not versioned with the game, and this is a network
// dependency at runtime - if it's unreachable or moves, weapon names fall
// back to a humanized internal name or the raw defindex (see
// resolveDisplayName). Never used for anything that affects what gets sent
// to the GC.
const TF_ENGLISH_LANG_URL = 'https://raw.githubusercontent.com/SteamDatabase/GameTracking-TF2/master/tf/resource/tf_english.txt';

// Only tool def_indexes actually seen in a real dump get a friendly name -
// see README's confirmed-vs-inferred split. Anything else is shown as-is
// rather than guessed at.
const KNOWN_TOOL_CATEGORIES = {
	20002: 'Specialized Killstreak Kit Fabricator',
	20003: 'Professional Killstreak Kit Fabricator',
};

// CONFIRMED EMPIRICALLY (real craft, not theory): each weaponChoice slot
// (see parseRecipe) needs weapons meeting a kit-tier precondition that
// depends on the Fabricator's own tier. This library cannot validate it
// (see README) - it's shown to the human picking the weapon instead.
const WEAPON_REQUIREMENT_BY_TOOL_DEFINDEX = {
	20002: 'cada arma debe ser Unique y ya tener un Killstreak Kit normal (tier 1, no Specialized/Professional) aplicado',
	20003: 'cada arma debe ser Unique y ya tener un Specialized Killstreak Kit aplicado',
};

// The tier number detectKillstreakTier should find on a matching weapon.
// Tier 1 = normal Killstreak, confirmed against a real dumped weapon (see
// git history / README). Tiers 2 (Specialized) and 3 (Professional) are only
// presumed to be the standard IEEE-754 float32 values 2.0 / 3.0 the same way
// - not individually confirmed against a real weapon of those tiers.
const REQUIRED_WEAPON_TIER_BY_TOOL_DEFINDEX = {
	20002: 1,
	20003: 2,
};

function categoryFor(defIndex) {
	return KNOWN_TOOL_CATEGORIES[defIndex] || `def_index ${defIndex} (categoría no confirmada)`;
}

function weaponRequirementText(toolDefIndex) {
	return WEAPON_REQUIREMENT_BY_TOOL_DEFINDEX[toolDefIndex] || 'requisito de kit del arma no confirmado para esta categoría de Fabricator - verificá manualmente antes de confirmar';
}

function requiredWeaponTier(toolDefIndex) {
	return REQUIRED_WEAPON_TIER_BY_TOOL_DEFINDEX[toolDefIndex] ?? null;
}

function fetchText(url, timeoutMs = 15000) {
	return new Promise((resolve, reject) => {
		const req = https.get(url, (res) => {
			if (res.statusCode !== 200) {
				res.resume();
				reject(new Error(`HTTP ${res.statusCode} fetching ${url}`));
				return;
			}
			const chunks = [];
			res.on('data', (c) => chunks.push(c));
			res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
		});
		req.on('error', reject);
		req.setTimeout(timeoutMs, () => req.destroy(new Error('timed out fetching ' + url)));
	});
}

/**
 * Best-effort item name lookup, only used for display. Never fails hard:
 * falls back to a humanized internal dev name, then to a bare defindex.
 */
async function loadWeaponNameLang() {
	try {
		const text = await fetchText(TF_ENGLISH_LANG_URL);
		const parsed = VDF.parse(text);
		return (parsed.lang && parsed.lang.Tokens) || null;
	} catch (err) {
		console.log(`Aviso: no pude descargar nombres de items (${err.message}). Se van a mostrar nombres internos/defindex.`);
		return null;
	}
}

function waitForItemSchema(tf2, timeoutMs = 20000) {
	if (tf2.itemSchema) {
		return Promise.resolve(tf2.itemSchema);
	}
	return new Promise((resolve) => {
		const timer = setTimeout(() => resolve(tf2.itemSchema || null), timeoutMs);
		tf2.once('itemSchemaLoaded', () => {
			clearTimeout(timer);
			resolve(tf2.itemSchema);
		});
	});
}

/** "TF_WEAPON_FIREAXE" -> "Fireaxe". Rough fallback when there's no lang token. */
function humanizeInternalName(name) {
	if (!name) return null;
	return name
		.replace(/^TF_WEAPON_/i, '')
		.toLowerCase()
		.split(/[_\s]+/)
		.filter(Boolean)
		.map((w) => w[0].toUpperCase() + w.slice(1))
		.join(' ');
}

/**
 * Resolves a display name for an item defindex. Prefers the real localized
 * name (item_name token resolved against the lang file); falls back to a
 * humanized internal dev name; falls back to the bare defindex. Display-only
 * - never used to decide what gets sent.
 */
function resolveDisplayName(defIndex, itemSchema, lang) {
	const item = itemSchema && itemSchema.items ? itemSchema.items[String(defIndex)] : null;
	if (!item) {
		return `defindex ${defIndex}`;
	}
	if (item.item_name && item.item_name.startsWith('#') && lang) {
		const resolved = lang[item.item_name.substring(1)];
		if (resolved) return resolved;
	}
	return humanizeInternalName(item.name) || `defindex ${defIndex}`;
}

/**
 * Display string for a robot-part input itemdef: static lookup via
 * lib/robotPartCatalog.js (no network, no live item schema needed - see
 * that module's doc comment). Falls back to the bare itemdef, never throws,
 * for anything outside the 8 confirmed robot parts.
 */
function describeItemDef(itemDefIndex) {
	const name = robotPartName(itemDefIndex);
	return name ? `${name} (itemdef ${itemDefIndex})` : `itemdef ${itemDefIndex}`;
}

/**
 * CONFIRMED against a real captured weapon (a Killstreak Mantreads, tier 1):
 * killstreak tier lives in attribute 2025's `value_bytes`, as a little-endian
 * float32 (hex 0000803f = 1.0 = tier 1) - NOT in the `value` field, which
 * came back null/absent on the real item. A weapon with no killstreak kit at
 * all simply has no attribute 2025 present. Tiers above 1 are only presumed
 * to be the standard float32 2.0 / 3.0 bit patterns (see
 * REQUIRED_WEAPON_TIER_BY_TOOL_DEFINDEX) - only tier 1 has been verified.
 */
function detectKillstreakTier(item) {
	const attr = (item.attribute || []).find((a) => a.def_index === KILLSTREAK_TIER_ATTRIBUTE_DEFINDEX);
	if (!attr || !attr.value_bytes || attr.value_bytes.length < 4) {
		return null;
	}
	const tier = Math.round(attr.value_bytes.readFloatLE(0));
	return Number.isFinite(tier) && tier > 0 ? tier : null;
}

/**
 * Candidate weapons for a weaponChoice slot: Unique quality + a combat weapon
 * slot (primary/secondary/melee - killstreak kits don't apply to cosmetics,
 * PDAs, or action items). detectKillstreakTier is confirmed for tier 1 (see
 * its own doc comment) but candidates are still never EXCLUDED by it -
 * matches are just sorted first and marked clearly, in case detection is
 * wrong for some item (legacy encoding, tier 2/3 not individually verified,
 * etc) - the human always sees the full list and makes the final call.
 *
 * @param {number|null} requiredTier - from requiredWeaponTier(recipe.toolDefIndex); null if unknown
 */
function findWeaponCandidates(backpack, itemSchema, lang, requiredTier) {
	const candidates = (backpack || [])
		.filter((item) => {
			if (item.quality !== UNIQUE_QUALITY) return false;
			const def = itemSchema && itemSchema.items ? itemSchema.items[String(item.def_index)] : null;
			return !!def && WEAPON_ITEM_SLOTS.has(def.item_slot);
		})
		.map((item) => {
			const detectedTier = detectKillstreakTier(item);
			return {
				id: item.id,
				defIndex: item.def_index,
				displayName: resolveDisplayName(item.def_index, itemSchema, lang),
				detectedTier,
				matchesRequirement: requiredTier != null && detectedTier === requiredTier,
			};
		});

	candidates.sort((a, b) => Number(b.matchesRequirement) - Number(a.matchesRequirement));
	return candidates;
}

/**
 * Parses a dynamic recipe item for display purposes. Never throws - a single
 * unparseable item shouldn't take down the whole listing; it's just shown
 * with its error instead and can't be picked.
 */
function describeItem(item) {
	try {
		return { item, recipe: parseRecipe(item), category: categoryFor(item.def_index), error: null };
	} catch (err) {
		return { item, recipe: null, category: categoryFor(item.def_index), error: err.message };
	}
}

function printItemSummary(idx, described) {
	const { item, recipe, category, error } = described;
	console.log(`  [${idx}] id=${item.id} - ${category}`);
	if (error) {
		console.log(`      no se pudo parsear: ${error}`);
		return;
	}
	console.log(`      output: itemdef ${recipe.output.itemDefIndex} x${recipe.output.quantityRequired} (quality ${recipe.output.quality})`);
	recipe.inputs.forEach((s) => {
		console.log(`      input:  ${describeItemDef(s.itemDefIndex)} x${s.quantityRequired} (quality ${s.quality})`);
	});
	recipe.weaponChoices.forEach((s) => {
		console.log(`      weapon: ${s.quantityRequired}x elección manual - ${weaponRequirementText(recipe.toolDefIndex)}`);
	});
}

function ask(question) {
	return new Promise((resolve) => {
		const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
		rl.question(question, (answer) => {
			rl.close();
			resolve(answer.trim());
		});
	});
}

function findDynamicRecipeItems(backpack) {
	return backpack.filter((item) => (item.attribute || []).some((a) => a.def_index >= SLOT_MIN && a.def_index <= SLOT_MAX));
}

/**
 * Greedily assigns backpack stacks to a slot's required itemdef/quality,
 * tracking `reserved` quantity per item id so the same physical stack is
 * never double-booked across two slots in the same run.
 */
function selectComponentsForSlot(backpack, slot, toolItemId, reserved) {
	const candidates = backpack
		.filter((i) => i.def_index === slot.itemDefIndex && i.quality === slot.quality && String(i.id) !== String(toolItemId))
		.map((i) => ({ id: i.id, available: (i.quantity || 1) - (reserved.get(String(i.id)) || 0) }))
		.filter((c) => c.available > 0)
		.sort((a, b) => b.available - a.available);

	const chosen = [];
	let remaining = slot.quantityRequired;
	for (const c of candidates) {
		if (remaining <= 0) break;
		const take = Math.min(c.available, remaining);
		chosen.push({ id: c.id, quantity: take });
		reserved.set(String(c.id), (reserved.get(String(c.id)) || 0) + take);
		remaining -= take;
	}

	return { chosen, satisfied: remaining <= 0, shortBy: Math.max(remaining, 0) };
}

function buildPlan(backpack, recipe) {
	const reserved = new Map();
	const plan = [];
	let allSatisfied = true;

	for (const slot of recipe.inputs) {
		const result = selectComponentsForSlot(backpack, slot, recipe.toolItemId, reserved);
		if (!result.satisfied) allSatisfied = false;
		plan.push({ slot, ...result });
	}

	return { plan, allSatisfied };
}

function printPlan(recipe, plan) {
	console.log(`\nOutput: itemdef ${recipe.output.itemDefIndex}, quality ${recipe.output.quality}`);
	if (recipe.output.extraAttributes.length) {
		console.log('  preset attributes (raw, unparsed):', recipe.output.extraAttributes);
	}
	if (recipe.attributeSlots.length) {
		console.log('  non-item metadata slots (not sent, purpose unconfirmed - see README):', recipe.attributeSlots.map((s) => `#${s.attributeIndex} extraAttributes=${JSON.stringify(s.extraAttributes)}`));
	}

	console.log('\nInput plan (auto-detected from backpack):');
	for (const { slot, chosen, satisfied, shortBy } of plan) {
		console.log(`  slot ${slot.attributeIndex}: ${describeItemDef(slot.itemDefIndex)} quality ${slot.quality} x${slot.quantityRequired}`);
		if (chosen.length === 0) {
			console.log('    -> NOTHING FOUND in backpack');
		} else {
			chosen.forEach((c) => console.log(`    -> item ${c.id} (using ${c.quantity})`));
		}
		if (!satisfied) {
			console.log(`    -> SHORT by ${shortBy} unit(s)`);
		}
	}

	if (recipe.weaponChoices.length) {
		console.log('\nWeapon slot(s) (cannot be auto-detected, will ask separately):');
		recipe.weaponChoices.forEach((s) => console.log(`  slot ${s.attributeIndex}: ${s.quantityRequired} arma(s) - ${weaponRequirementText(recipe.toolDefIndex)}`));
	}
}

/**
 * Interactively asks the user to pick exactly quantityRequired weapons per
 * weaponChoice slot, BY INDEX from a candidate list built from their own
 * backpack (Unique + combat weapon slot) - never a raw item id, since there's
 * no way to know one by heart. Candidates matching the required tier (see
 * findWeaponCandidates) are sorted first and marked, but never excluded from
 * the list - the human always sees everything and makes the final call.
 * askFn is injectable for testing.
 */
async function collectWeaponChoices(recipe, backpack, itemSchema, lang, askFn = ask) {
	const assignments = {};

	for (const slot of recipe.weaponChoices) {
		const requiredTier = requiredWeaponTier(recipe.toolDefIndex);
		const candidates = findWeaponCandidates(backpack, itemSchema, lang, requiredTier);

		console.log(`\nSlot ${slot.attributeIndex} requiere ${slot.quantityRequired} arma(s).`);
		console.log(`Requisito: ${weaponRequirementText(recipe.toolDefIndex)}`);

		if (candidates.length === 0) {
			console.log('  No encontré armas Unique (primary/secondary/melee) en tu backpack. No se va a poder completar este slot.');
			assignments[slot.attributeIndex] = [];
			continue;
		}

		console.log('  Candidatas en tu backpack (tier detectado por atributo 2025 - confirmado para tier 1, no para 2/3 - confirmá vos igual):');
		candidates.forEach((c, idx) => {
			let tierNote;
			if (c.matchesRequirement) {
				tierNote = `✓ tier ${c.detectedTier} - cumple el requisito`;
			} else if (c.detectedTier) {
				tierNote = `tier ${c.detectedTier} detectado - NO coincide con el requisito${requiredTier != null ? ` (necesita tier ${requiredTier})` : ''}`;
			} else {
				tierNote = 'sin killstreak detectado - confirmá a mano';
			}
			console.log(`    [${idx}] ${c.displayName} (defindex ${c.defIndex}, id ${c.id}) - ${tierNote}`);
		});

		let chosenIndices = null;
		while (!chosenIndices) {
			const answer = await askFn(`  Elegí ${slot.quantityRequired} índice(s) separados por coma: `);
			const nums = answer
				.split(',')
				.map((s) => s.trim())
				.filter((s) => s.length > 0)
				.map(Number);

			const valid = nums.length === slot.quantityRequired && nums.every((n) => Number.isInteger(n) && n >= 0 && n < candidates.length) && new Set(nums).size === nums.length;

			if (!valid) {
				console.log(`  Entrada inválida - necesito exactamente ${slot.quantityRequired} índice(s) distintos entre 0 y ${candidates.length - 1}.`);
				continue;
			}
			chosenIndices = nums;
		}

		assignments[slot.attributeIndex] = chosenIndices.map((i) => candidates[i].id);
	}

	return assignments;
}

async function main() {
	let accountName = process.env.STEAM_USERNAME;
	let password = process.env.STEAM_PASSWORD;
	if (!accountName) accountName = await ask('Steam username: ');
	if (!password) password = await ask('Steam password: ');

	const client = new SteamUser();
	const tf2 = new TeamFortress2(client);
	attachDynamicRecipeSupport(tf2);

	// Kicked off now, in parallel with login - only used for display, so a
	// slow/failed fetch never blocks anything, see loadWeaponNameLang().
	const langPromise = loadWeaponNameLang();

	const timeout = setTimeout(() => {
		console.error('\nTimed out waiting for backpack to load.');
		process.exit(1);
	}, 90000);

	client.on('steamGuard', async (domain, callback) => {
		const code = await ask(domain ? `Steam Guard code emailed to ${domain}: ` : 'Steam Guard mobile code: ');
		callback(code);
	});

	client.on('error', (err) => {
		clearTimeout(timeout);
		console.error('steam-user error:', err.message);
		process.exit(1);
	});

	client.on('loggedOn', () => {
		console.log('Logged into Steam. Launching TF2...');
		client.gamesPlayed([440]);
	});

	// Always on for this script - this is the exact signal the README's
	// "Next steps" checklist asks you to watch for.
	tf2.on('debug', (msg) => console.log('[tf2 debug]', msg));

	tf2.on('connectedToGC', () => console.log('Connected to TF2 GC. Waiting for backpack...'));

	tf2.on('backpackLoaded', async () => {
		clearTimeout(timeout);

		const items = findDynamicRecipeItems(tf2.backpack);
		if (items.length === 0) {
			console.log('No dynamic recipe items (Fabricators/Chemistry Sets) found in backpack.');
			return client.logOff();
		}

		const described = items.map(describeItem);
		console.log(`\nFound ${described.length} dynamic recipe item(s):`);
		described.forEach((d, idx) => printItemSummary(idx, d));

		const choice = await ask('\nPick one by index (or "q" to quit): ');
		if (choice.toLowerCase() === 'q') {
			return client.logOff();
		}
		const chosen = described[Number(choice)];
		if (!chosen || chosen.error) {
			console.error('Invalid choice.');
			return client.logOff();
		}
		const { item: toolItem, recipe } = chosen;

		const { plan, allSatisfied } = buildPlan(tf2.backpack, recipe);
		printPlan(recipe, plan);

		if (!allSatisfied) {
			console.log('\nNot all inputs are available in your backpack. Nothing will be sent (not even asking for weapons).');
			return client.logOff();
		}

		const assignments = {};
		for (const { slot, chosen } of plan) {
			assignments[slot.attributeIndex] = chosen.length === 1 ? chosen[0].id : chosen.map((c) => c.id);
		}

		if (recipe.weaponChoices.length > 0) {
			console.log('\nCargando item schema para poder listar tus armas...');
			const itemSchema = await waitForItemSchema(tf2);
			if (!itemSchema) {
				console.log('  Aviso: no se pudo cargar el item schema a tiempo - la lista de candidatas puede salir vacía.');
			}
			const lang = await langPromise;
			Object.assign(assignments, await collectWeaponChoices(recipe, tf2.backpack, itemSchema, lang));
		}

		const validation = validateAssignments(recipe, assignments, tf2.backpack);

		console.log('\n=== Validación final ===');
		if (validation.warnings.length) {
			console.log('Avisos (NO validados automáticamente - verificar a mano):');
			validation.warnings.forEach((w) => console.log('  -', w.message));
		}
		if (!validation.ok) {
			console.log('Faltan componentes, no se va a enviar nada:');
			validation.missing.forEach((m) => console.log('  -', JSON.stringify(m)));
			return client.logOff();
		}

		if (DRY_RUN) {
			console.log('\n--dry-run: stopping here, nothing was sent.');
			return client.logOff();
		}

		console.log('\nThis will send FulfillDynamicRecipeComponent to the GC and consume the items listed above.');
		console.log('This cannot be undone and has NOT been empirically verified to work yet (see README).');
		const confirmation = await ask(`Type "${CONFIRM_PHRASE}" to proceed, anything else to abort: `);
		if (confirmation !== CONFIRM_PHRASE) {
			console.log('Aborted. Nothing was sent.');
			return client.logOff();
		}

		console.log('\nSending...');
		const result = await tf2.fulfillDynamicRecipe(toolItem.id, assignments, { timeoutMs: 20000 });

		console.log('\n=== Result ===');
		console.log('sent:', result.sent, '| acknowledged:', result.acknowledged, '| timedOut:', result.timedOut);
		if (result.raw) {
			console.log('raw response hex:', Buffer.from(result.raw).toString('hex'));
		}
		console.log('inventory events observed while waiting:', JSON.stringify(result.inventoryEvents, null, 2));
		console.log('\nCompare this against README.md "Next steps" to figure out what it means.');

		client.logOff();
	});

	console.log('Logging in...');
	client.logOn({ accountName, password });
}

if (require.main === module) {
	main().catch((err) => {
		console.error(err);
		process.exit(1);
	});
}

module.exports = {
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
	describeItemDef,
	detectKillstreakTier,
	findWeaponCandidates,
};
