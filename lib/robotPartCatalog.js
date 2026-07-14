'use strict';

/**
 * Static name table for the 8 real Killstreak Fabricator robot-part inputs
 * (itemdef 5700-5707, "Robits Loot 01".."08" in items_game.txt). These are
 * fixed catalog items - their names don't change - so this is hardcoded
 * instead of fetched from the network on every lookup. Confirmed against the
 * live item schema via scripts/robot-part-names.js on 2026-07-14; re-run
 * that script against the live schema mirror if these ever need
 * re-verifying (e.g. after a TF2 update that renames something).
 *
 * Deliberately excludes 5708/5709: those defindexes are adjacent in the
 * range but are NOT robot parts (Fall 2013 Halloween crates) - see
 * scripts/robot-part-names.js's ADJACENT_NON_ROBOT_PART_DEFINDEXES.
 */
const ROBOT_PART_NAMES = {
	5700: 'Pristine Robot Currency Digester',
	5701: 'Pristine Robot Brainstorm Bulb',
	5702: 'Reinforced Robot Emotion Detector',
	5703: 'Reinforced Robot Humor Suppression Pump',
	5704: 'Reinforced Robot Bomb Stabilizer',
	5705: 'Battle-Worn Robot Taunt Processor',
	5706: 'Battle-Worn Robot KB-808',
	5707: 'Battle-Worn Robot Money Furnace',
};

/**
 * Looks up a robot part's display name by itemdef. Returns null for
 * anything outside the known 5700-5707 set (including 5708/5709) rather
 * than guessing - callers should fall back to showing the bare itemdef.
 */
function robotPartName(itemDefIndex) {
	return ROBOT_PART_NAMES[itemDefIndex] || null;
}

module.exports = { ROBOT_PART_NAMES, robotPartName };
