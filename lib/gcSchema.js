'use strict';

/**
 * Single point of contact with node-tf2's internals for the dynamic-recipe
 * feature. node-tf2 (DoctorMcKay) does not implement FulfillDynamicRecipeComponent
 * (see jamtat's unmerged 2015 PR - DoctorMcKay/node-tf2#7), so everything here
 * reaches past its public API into the bundled Language enum and generated
 * protobuf schema, which node-tf2 itself uses the same way internally
 * (see its own handlers.js / index.js).
 */

const Language = require('tf2/language.js');
const Schema = require('tf2/protobufs/generated/_load.js');

module.exports = { Language, Schema };
