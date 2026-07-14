'use strict';

/**
 * Diagnostic-only script: logs into Steam, connects to the TF2 GC, and dumps
 * the raw structure of any backpack item that carries a dynamic-recipe
 * attribute (defindex 2000-2009) — i.e. Killstreak Kit Fabricators or
 * Chemistry Sets. It does NOT send FulfillDynamicRecipeComponent or modify
 * anything. Read-only.
 *
 * Usage:
 *   node scripts/dump-fabricator.js
 *
 * Credentials: set STEAM_USERNAME / STEAM_PASSWORD env vars beforehand, or
 * you'll be prompted (input is NOT masked - don't use this on a shared screen).
 */

const readline = require('readline');
const SteamUser = require('steam-user');
const TeamFortress2 = require('tf2');
const Schema = require('tf2/protobufs/generated/_load.js');

const RECIPE_SLOT_MIN = 2000;
const RECIPE_SLOT_MAX = 2009;

function ask(question, { hidden = false } = {}) {
	return new Promise((resolve) => {
		const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
		if (hidden) {
			// Best-effort masking; not perfect on all terminals, but avoids plain echo.
			rl._writeToOutput = (s) => rl.output.write('*'.repeat(s.length) || '');
		}
		rl.question(question, (answer) => {
			rl.close();
			resolve(answer.trim());
		});
	});
}

function decodeValueBytes(buf) {
	const out = { ok: false };
	out.hex = Buffer.isBuffer(buf) ? buf.toString('hex') : null;
	try {
		const msg = Schema.CAttribute_DynamicRecipeComponent.decode(buf);
		out.asDynamicRecipeComponent = Schema.CAttribute_DynamicRecipeComponent.toObject(msg, { longs: String, defaults: true });
		out.ok = true;
	} catch (err) {
		out.dynamicRecipeComponentError = err.message;
	}
	try {
		const msg = Schema.CAttribute_DynamicRecipeComponent_COMPAT_NEVER_SERIALIZE_THIS_OUT.decode(buf);
		out.asCompatComponent = Schema.CAttribute_DynamicRecipeComponent_COMPAT_NEVER_SERIALIZE_THIS_OUT.toObject(msg, { longs: String, defaults: true });
	} catch (err) {
		out.compatComponentError = err.message;
	}
	return out;
}

async function main() {
	let accountName = process.env.STEAM_USERNAME;
	let password = process.env.STEAM_PASSWORD;

	if (!accountName) accountName = await ask('Steam username: ');
	if (!password) password = await ask('Steam password: ', { hidden: true });

	const client = new SteamUser();
	const tf2 = new TeamFortress2(client);

	const timeout = setTimeout(() => {
		console.error('\nTimed out waiting for backpack to load. Check that TF2 is not already running elsewhere and that the account owns TF2.');
		process.exit(1);
	}, 90000);

	client.on('steamGuard', async (domain, callback) => {
		const prompt = domain
			? `Steam Guard code was emailed to ${domain}: `
			: 'Steam Guard mobile authenticator code: ';
		const code = await ask(prompt);
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

	tf2.on('debug', (msg) => {
		if (process.env.DEBUG_TF2) console.log('[tf2 debug]', msg);
	});

	tf2.on('connectedToGC', () => {
		console.log('Connected to TF2 GC. Waiting for backpack...');
	});

	tf2.on('backpackLoaded', () => {
		clearTimeout(timeout);
		console.log(`Backpack loaded: ${tf2.backpack.length} items. Scanning for dynamic-recipe items...\n`);

		const matches = tf2.backpack.filter((item) =>
			(item.attribute || []).some((a) => a.def_index >= RECIPE_SLOT_MIN && a.def_index <= RECIPE_SLOT_MAX)
		);

		if (matches.length === 0) {
			console.log('No items with attributes in the 2000-2009 range were found in this backpack.');
		} else {
			matches.forEach((item, idx) => {
				console.log(`=== Match ${idx + 1} ===`);
				console.log(JSON.stringify({
					id: item.id,
					original_id: item.original_id,
					def_index: item.def_index,
					quality: item.quality,
					level: item.level,
					flags: item.flags,
					quantity: item.quantity,
					custom_name: item.custom_name,
				}, null, 2));

				console.log('-- attributes (all) --');
				(item.attribute || []).forEach((a) => {
					const inRecipeRange = a.def_index >= RECIPE_SLOT_MIN && a.def_index <= RECIPE_SLOT_MAX;
					console.log(`  def_index=${a.def_index}${inRecipeRange ? ' [RECIPE SLOT]' : ''} value=${a.value ?? ''}`);
					if (a.value_bytes && a.value_bytes.length) {
						const decoded = decodeValueBytes(a.value_bytes);
						console.log('    ' + JSON.stringify(decoded));
					}
				});
				console.log('');
			});
		}

		console.log('Done. Logging off.');
		client.logOff();
		setTimeout(() => process.exit(0), 1000);
	});

	console.log('Logging in...');
	client.logOn({ accountName, password });
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
