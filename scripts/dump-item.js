'use strict';

/**
 * Diagnostic-only script: logs into Steam, connects to the TF2 GC, and dumps
 * EVERY attribute of one specific backpack item by id - def_index, raw
 * `value` (also shown reinterpreted as a float32, since most TF2 attributes
 * are stored that way), and value_bytes hex if present. Read-only, sends
 * nothing.
 *
 * Used to settle disputes about which attribute defindex means what on a
 * REAL captured item, instead of guessing from schema names alone.
 *
 * Usage:
 *   node scripts/dump-item.js <itemId>
 */

const readline = require('readline');
const SteamUser = require('steam-user');
const TeamFortress2 = require('tf2');

const itemId = process.argv[2];
if (!itemId) {
	console.error('Usage: node scripts/dump-item.js <itemId>');
	process.exit(1);
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

function floatFromUint32(value) {
	const buf = Buffer.alloc(4);
	buf.writeUInt32LE(value >>> 0, 0);
	return buf.readFloatLE(0);
}

async function main() {
	let accountName = process.env.STEAM_USERNAME;
	let password = process.env.STEAM_PASSWORD;
	if (!accountName) accountName = await ask('Steam username: ');
	if (!password) password = await ask('Steam password: ');

	const client = new SteamUser();
	const tf2 = new TeamFortress2(client);

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

	tf2.on('connectedToGC', () => console.log('Connected to TF2 GC. Waiting for backpack...'));

	tf2.on('backpackLoaded', () => {
		clearTimeout(timeout);

		const item = tf2.backpack.find((i) => String(i.id) === String(itemId));
		if (!item) {
			console.log(`Item ${itemId} not found in backpack.`);
			return client.logOff();
		}

		console.log(`\n=== item ${item.id} ===`);
		console.log(JSON.stringify({ def_index: item.def_index, quality: item.quality, level: item.level, flags: item.flags, custom_name: item.custom_name }, null, 2));

		console.log('\n-- attributes (all) --');
		(item.attribute || []).forEach((a) => {
			const asFloat = a.value !== undefined && a.value !== null ? floatFromUint32(a.value) : null;
			console.log(`  def_index=${a.def_index} value=${a.value} asFloat=${asFloat}${a.value_bytes && a.value_bytes.length ? ' value_bytes_hex=' + a.value_bytes.toString('hex') : ''}`);
		});

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
