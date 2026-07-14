'use strict';

/**
 * Read-only, offline name-resolution table for the itemdefs that show up as
 * dynamic-recipe inputs/outputs in Killstreak Kit Fabricators: robot parts
 * (5700-5707) and the Kit outputs themselves (6523 Specialized, 6526
 * Professional). No Steam login, no GC connection, nothing sent anywhere -
 * just resolves names from TF2's public item schema + lang file, the same
 * way scripts/fulfill-recipe.js's resolveDisplayName() does for weapons,
 * except fetched directly over HTTP instead of through a live GC session
 * (which would require logging in).
 *
 * There is no field literally called "market_hash_name" anywhere in the
 * schema - only "can_affect_market_name" flags on individual attributes.
 * What this prints is the resolved in-game display name (item_name token ->
 * lang file). For plain Unique-quality items like these robot parts, Unique
 * quality gets no prefix on the Steam Market, so this should match what
 * backpack.tf / the Market call them - but that has NOT been independently
 * verified against either, only against the item schema itself.
 *
 * Usage:
 *   node scripts/robot-part-names.js
 */

const https = require('https');
const VDF = require('kvparser');

const ITEMS_GAME_URL = 'https://raw.githubusercontent.com/SteamDatabase/GameTracking-TF2/master/tf/scripts/items/items_game.txt';
const TF_ENGLISH_LANG_URL = 'https://raw.githubusercontent.com/SteamDatabase/GameTracking-TF2/master/tf/resource/tf_english.txt';

// The full "Robits Loot 01".."08" set - confirmed as the actual dynamic-recipe
// inputs across every real Fabricator sampled (test/fixtures/realFabricators.js).
const ROBOT_PART_DEFINDEXES = [5700, 5701, 5702, 5703, 5704, 5705, 5706, 5707];

// Adjacent in defindex space, but NOT robot parts (confirmed against the real
// schema: these resolve to Fall 2013 Halloween crates). Included, not
// silently dropped, because they fall inside the 5700-5709 range - flagged
// instead of presented as if they were Fabricator inputs.
const ADJACENT_NON_ROBOT_PART_DEFINDEXES = [5708, 5709];

// Killstreak Kit outputs (parseRecipe's `output` slot: itemDefIndex 6523 for
// Specialized Fabricators, 6526 for Professional - see README).
const KIT_DEFINDEXES = [6523, 6526];

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

/** "TF_WEAPON_FIREAXE" -> "Fireaxe". Same fallback as fulfill-recipe.js's humanizeInternalName. */
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
 * Same resolution order as fulfill-recipe.js's resolveDisplayName: real
 * localized name first, humanized internal dev name next, bare defindex last.
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
 * Pure: builds the itemdef -> name table from already-parsed schema + lang.
 * No I/O, so this is what's unit-tested (see test/robotPartNames.test.js) -
 * fetchText/main() are just the thin network wrapper around it.
 */
function buildTable(itemSchema, lang) {
	const rows = [];

	for (const defIndex of ROBOT_PART_DEFINDEXES) {
		rows.push({ defIndex, name: resolveDisplayName(defIndex, itemSchema, lang), note: '' });
	}

	for (const defIndex of ADJACENT_NON_ROBOT_PART_DEFINDEXES) {
		rows.push({
			defIndex,
			name: resolveDisplayName(defIndex, itemSchema, lang),
			note: 'NOT a robot part in the schema - do not treat as a Fabricator input',
		});
	}

	for (const defIndex of KIT_DEFINDEXES) {
		rows.push({
			defIndex,
			name: resolveDisplayName(defIndex, itemSchema, lang),
			note: 'generic placeholder - real market name depends on the specific weapon + tier this kit targets, not derivable from defindex alone',
		});
	}

	return rows;
}

function printTable(rows) {
	const defWidth = Math.max(...rows.map((r) => String(r.defIndex).length), 'itemdef'.length);
	const nameWidth = Math.max(...rows.map((r) => r.name.length), 'name'.length);

	console.log('\n' + 'itemdef'.padEnd(defWidth) + '  ' + 'name'.padEnd(nameWidth) + '  note');
	console.log('-'.repeat(defWidth) + '  ' + '-'.repeat(nameWidth) + '  ' + '-'.repeat(20));
	rows.forEach((r) => {
		console.log(String(r.defIndex).padEnd(defWidth) + '  ' + r.name.padEnd(nameWidth) + (r.note ? '  ' + r.note : ''));
	});

	console.log(
		'\nNote: these are resolved in-game display names, not a field literally called "market_hash_name" ' +
			'(no such field exists in the schema - see script header comment). For plain Unique-quality items ' +
			'like these robot parts, this should match what backpack.tf/the Steam Market call them, but that has ' +
			'not been independently verified against either.'
	);
}

async function main() {
	console.log('Fetching item schema and lang file (read-only, no Steam login, no GC connection)...');
	const [itemsGameText, langText] = await Promise.all([fetchText(ITEMS_GAME_URL), fetchText(TF_ENGLISH_LANG_URL)]);

	const itemSchema = VDF.parse(itemsGameText).items_game;
	const lang = VDF.parse(langText).lang.Tokens;

	printTable(buildTable(itemSchema, lang));
}

if (require.main === module) {
	main().catch((err) => {
		console.error(err);
		process.exit(1);
	});
}

module.exports = {
	ROBOT_PART_DEFINDEXES,
	ADJACENT_NON_ROBOT_PART_DEFINDEXES,
	KIT_DEFINDEXES,
	humanizeInternalName,
	resolveDisplayName,
	buildTable,
};
