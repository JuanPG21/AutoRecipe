'use strict';

/**
 * Real Killstreak Kit Fabricators pulled from a live backpack via
 * scripts/dump-fabricator.js on 2026-07-14. value_bytes are the exact raw
 * bytes the GC sent - not hand-constructed - so tests against these
 * fixtures exercise the real wire format, not our assumptions about it.
 * `id`/`original_id` are anonymized placeholders (the real item ids were not
 * needed for anything these tests check) - everything else is untouched.
 *
 * Match 1 / Match 2: Specialized Killstreak Kit Fabricator (tool def_index 20002)
 * Match 3: Professional Killstreak Kit Fabricator (tool def_index 20003)
 */

function attr(defIndex, hex) {
	return { def_index: defIndex, value_bytes: Buffer.from(hex, 'hex') };
}

const specializedFabricator1 = {
	id: '1111111111',
	original_id: '1111111100',
	def_index: 20002,
	quality: 6,
	level: 9,
	flags: 4,
	quantity: 1,
	custom_name: null,
	attribute: [
		attr(2022, '0000803f'),
		attr(2000, '0800100618182210323032357c010201037c010201037c3128013000'),
		attr(2001, '08c92c1006180c2200280c3000'),
		attr(2002, '08cb2c1006180c220028093000'),
		attr(2003, '08ca2c1006180c220028033000'),
		attr(2004, '08c62c1006180c220028053000'),
		attr(2005, '08fb321006180d223b323031347c010201037c010201037c362e3030303030307c010201037c010201037c323031327c010201037c010201037c3139352e30303030303028013000'),
	],
};

const specializedFabricator2 = {
	id: '2222222222',
	original_id: null,
	def_index: 20002,
	quality: 6,
	level: 11,
	flags: 0,
	quantity: 1,
	custom_name: null,
	attribute: [
		attr(2022, '0000803f'),
		attr(2000, '0800100618182210323032357c010201037c010201037c3128013000'),
		attr(2001, '08c92c1006180c2200280d3000'),
		attr(2002, '08ca2c1006180c220028043000'),
		attr(2003, '08cb2c1006180c220028073000'),
		attr(2004, '08c72c1006180c220028023000'),
		attr(2005, '08c62c1006180c220028023000'),
		attr(2006, '08c82c1006180c220028013000'),
		attr(2007, '08fb321006180d223b323031347c010201037c010201037c322e3030303030307c010201037c010201037c323031327c010201037c010201037c3435372e30303030303028013000'),
	],
};

const professionalFabricator = {
	id: '3333333333',
	original_id: null,
	def_index: 20003,
	quality: 6,
	level: 11,
	flags: 0,
	quantity: 1,
	custom_name: null,
	attribute: [
		attr(2022, '0000803f'),
		attr(2000, '0800100618182210323032357c010201037c010201037c3228023000'),
		attr(2001, '08c92c1006180c220028103000'),
		attr(2002, '08c72c1006180c220028033000'),
		attr(2003, '08c62c1006180c220028033000'),
		attr(2004, '08c52c1006180c2219323032327c010201037c010201037c3130363533353332313628023000'),
		attr(2005, '08c42c1006180c2219323032327c010201037c010201037c3130363533353332313628013000'),
		attr(2006, '08fe321006180d2260323031347c010201037c010201037c332e3030303030307c010201037c010201037c323031337c010201037c010201037c323030362e3030303030307c010201037c010201037c323031327c010201037c010201037c3532382e30303030303028013000'),
	],
};

module.exports = { specializedFabricator1, specializedFabricator2, professionalFabricator };
