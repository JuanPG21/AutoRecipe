'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { ROBOT_PART_NAMES, robotPartName } = require('../lib/robotPartCatalog.js');
const { ROBOT_PART_DEFINDEXES } = require('../scripts/robot-part-names.js');

test('ROBOT_PART_NAMES has exactly the 8 confirmed defindexes (5700-5707), no more, no less', () => {
	assert.deepEqual(
		Object.keys(ROBOT_PART_NAMES)
			.map(Number)
			.sort((a, b) => a - b),
		[5700, 5701, 5702, 5703, 5704, 5705, 5706, 5707]
	);
});

test('ROBOT_PART_NAMES stays in sync with scripts/robot-part-names.js\'s ROBOT_PART_DEFINDEXES', () => {
	// Both lists are maintained by hand in separate files - this guards
	// against them silently drifting apart.
	assert.deepEqual(
		Object.keys(ROBOT_PART_NAMES)
			.map(Number)
			.sort((a, b) => a - b),
		[...ROBOT_PART_DEFINDEXES].sort((a, b) => a - b)
	);
});

test('ROBOT_PART_NAMES excludes 5708/5709 (crates, not robot parts)', () => {
	assert.equal(ROBOT_PART_NAMES[5708], undefined);
	assert.equal(ROBOT_PART_NAMES[5709], undefined);
});

test('robotPartName returns the confirmed name for each of the 8 robot parts', () => {
	assert.equal(robotPartName(5700), 'Pristine Robot Currency Digester');
	assert.equal(robotPartName(5705), 'Battle-Worn Robot Taunt Processor');
	assert.equal(robotPartName(5707), 'Battle-Worn Robot Money Furnace');
});

test('robotPartName returns null for anything not a confirmed robot part, including the adjacent crates', () => {
	assert.equal(robotPartName(5708), null);
	assert.equal(robotPartName(5709), null);
	assert.equal(robotPartName(6523), null);
	assert.equal(robotPartName(1), null);
});
