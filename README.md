# AutoRecipe

Completes TF2 "dynamic recipes" (Killstreak Kit Fabricators, and theoretically
Chemistry Sets) via the game coordinator, using `tf2` (node-tf2) v4 +
`steam-user` v5. Pure logic only so far — no UI, no CLI to actually trigger a
craft yet.

## Why this isn't just `tf2.craft()`

Dynamic recipes don't use TF2's normal crafting message. They use
`FulfillDynamicRecipeComponent` (GC message 1085), which **node-tf2 does not
implement**. A 2015 PR by jamtat attempted it
([DoctorMcKay/node-tf2#7](https://github.com/DoctorMcKay/node-tf2/pull/7))
but was never merged, and it targets a since-replaced API (`steam.toGC`,
`steam.on('fromGC')`) that no longer exists in node-tf2 v4 / steam-user v5.
Everything here is implemented against the current API, extending a
`TeamFortress2` instance at runtime rather than depending on that PR or
patching the `tf2` package.

## Status

- `parseRecipe` — **verified** against 3 real Killstreak Kit Fabricators pulled
  live from a backpack (2x Specialized, 1x Professional). See
  `test/fixtures/realFabricators.js` (raw bytes, not hand-built) and
  `test/parseRecipe.test.js`.
- `fulfillDynamicRecipe` (the actual send) — **implemented but NOT
  empirically tested**. Validation and payload encoding are tested against
  real recipe data; the network round-trip against the live GC has not been
  exercised. Do not treat a green test suite as proof that crafting works.
- Chemistry Sets — **theoretical only**. They use the same GC message
  (`FulfillDynamicRecipeComponent`) and the same item-attribute encoding
  (defindex 2000-2009), so the architecture should support them, but none of
  this has been tested against a real Chemistry Set. Treat Chemistry Set
  support as unverified until someone actually runs it against one.

## What's confirmed vs. what's inferred

### Confirmed (from node-tf2's bundled `.proto` files, `items_game.txt`, and real captured bytes)

- `FulfillDynamicRecipeComponent` = GC msg 1085, `CMsgFulfillDynamicRecipeComponent { tool_item_id, consumption_components: [CMsgRecipeComponent{subject_item_id, attribute_index}] }` — exact match to the structure this project started from.
- Recipe slots live at item attribute defindex 2000-2009 (`items_game.txt`: "recipe component defined item 1..10", class `dynamic_recipe_component_defined_item`).
- Each slot's `value_bytes` decodes as `CAttribute_DynamicRecipeComponent { def_index, item_quality, component_flags, attributes_string, num_required, num_fulfilled }` — **not** the `_COMPAT_NEVER_SERIALIZE_THIS_OUT` variant, which is explicitly marked as not used for real serialization (and empirically mis-parses `num_required` into the wrong field).
- `attributes_string` is a sequence of real tokens separated by a literal `|` byte, where every gap between two real tokens contains the 4-byte control sequence `\x01\x02\x01\x03` **twice**. Splitting on single `|` bytes and discarding segments that are exactly that 4-byte filler recovers clean `(attribute defindex, raw value)` pairs. Verified against real output slots (sheen/killstreaker/tool-target-item triples) and real input slots (a `loot_rarity` requirement on the rarest robot parts of the Professional fabricator).
- There is **no `is_output` field on the wire**. Classification is inferred (see below) and validated against all 3 real samples, but that's 3 data points, not a spec.
- **A slot whose `itemDefIndex` decodes to 0, carrying attribute 2025 ("killstreak tier"), is a real "weaponChoice" requirement — CONFIRMED by an actual craft, not inferred.** It requires `quantityRequired` freely-chosen weapons (any weapon works structurally — `itemDefIndex` is 0, there's nothing to match against), sent as ordinary `CMsgRecipeComponent` entries the same as any other slot (`attribute_index` = the slot, e.g. 2000; `subject_item_id` = the chosen weapon's item id). Confirmed counts: **Specialized Fabricator needs 1 weapon** (must be Unique quality with a normal/tier-1 Killstreak Kit already applied); **Professional Fabricator needs 2 weapons** (must be Unique with a Specialized Killstreak Kit already applied on each). `parseRecipe` classifies these as `kind: 'weaponChoice'`; `validateAssignments`/`buildFulfillPayload` treat them as sendable components. **The kit-tier precondition on the chosen weapon(s) is NOT validated by this library** (checking whether a specific weapon already carries the right kit is nontrivial and out of scope for now) — `validateAssignments` only checks that exactly the right number of ids were given and that they exist in the backpack, and always returns a `warnings` entry reminding the caller to check the precondition by hand. `scripts/fulfill-recipe.js` prints this requirement text and asks for the weapon id(s) interactively — it cannot be auto-detected.

### Inferred / unconfirmed — flagged in code comments too

- **Output slot = highest-numbered slot present.** True for all 3 real Fabricators. Not derived from any documented flag.
- Any OTHER slot with `itemDefIndex` 0 that does **not** carry attribute 2025 (none seen yet) still falls back to `kind: 'attribute'` — surfaced but never sent, since its purpose isn't confirmed. This fallback exists specifically so a future, different-shaped itemdef-0 slot doesn't get silently misinterpreted as a weaponChoice.
- **The numeric values inside `attributes_string`** are inconsistently encoded — some are plain decimal (killstreak tier: `"1"`, `"2"`), others are the decimal text of the attribute's raw float32 bit pattern (`loot_rarity`: `"1065353216"` = bits of `1.0`). `parseRecipe` returns these as raw string tokens and does not attempt to normalize them, because I can't confirm the rule for which is which in general.
- **`component_flags`** (12/13/24/25 seen across samples) — no confirmed bitfield meaning. Passed through raw, unused by any logic.
- **`FulfillDynamicRecipeComponentResponse` (GC msg 1086) has no documented protobuf body anywhere in the available `.proto` sources** — and neither do any of its sibling "action response" messages (`ApplyXifierResponse`, `ItemEaterRechargerResponse`, `RemoveKillStreakResponse`). node-tf2 doesn't handle any of them either. `fulfillDynamicRecipe` currently correlates the response via `sendToGC`'s job-id callback (the documented request/response mechanism in steam-user), but **it's unconfirmed whether TF2's GC actually echoes `jobid_target` for this message**, or broadcasts it unsolicited the way `CraftResponse` is. If it's unsolicited, the job callback will simply never fire and every call will resolve via timeout (`acknowledged: false`) even on a real success.
- **Whether a slot needing N units should get one `CMsgRecipeComponent` (bulk-consuming a stacked item) or N repeated entries** is unconfirmed — the message has no quantity field, so bulk-consuming a single stack with sufficient `quantity` is the leading hypothesis. `fulfillRecipe`'s `assignments` format accepts either a single item id or an array per slot so both are expressible without code changes once this is known.

None of the above was guessed into "done" — see the Next Steps section for exactly what a live test needs to check.

## API

```js
const { parseRecipe } = require('./lib/parseRecipe.js');
const { validateAssignments, buildFulfillPayload } = require('./lib/fulfillRecipe.js');
const { attachDynamicRecipeSupport } = require('./lib/dynamicRecipeClient.js');
```

### `parseRecipe(item)`

Pure function. `item` is a backpack item as node-tf2 gives it (`{id, def_index, attribute: [{def_index, value_bytes}]}`). Returns:

```js
{
  toolItemId, toolDefIndex,
  inputs: [{ attributeIndex, itemDefIndex, quality, quantityRequired, quantityFulfilled, extraAttributes, kind: 'input' }, ...],
  weaponChoices: [{ ...same shape..., itemDefIndex: 0, kind: 'weaponChoice' }, ...], // CONFIRMED real - see above
  output: { ...same shape..., kind: 'output' },
  attributeSlots: [{ ...same shape..., kind: 'attribute' }, ...], // itemdef-0 slots NOT matching the weaponChoice pattern - purpose unconfirmed, never seen in practice
  slots: [...all of the above, sorted by attributeIndex],
}
```

Throws if `item` isn't a dynamic recipe tool (no attributes in 2000-2009).

### `validateAssignments(recipe, assignments, backpack)` / `buildFulfillPayload(toolItemId, recipe, assignments)`

Both in `lib/fulfillRecipe.js`. `assignments` is `{ [attributeIndex]: itemId | itemId[] }` and covers **both** `recipe.inputs` and `recipe.weaponChoices` the same way — a weaponChoice slot (e.g. 2000) just goes in under its own `attributeIndex` like any other slot. `validateAssignments` returns `{ ok, missing, warnings }`: `missing` blocks sending (wrong count, item not found, wrong itemdef/quality, insufficient quantity); `warnings` never blocks anything but flags things this library can't check by itself (currently: the weaponChoice kit-tier precondition).

### `attachDynamicRecipeSupport(tf2)`

Extends a live `TeamFortress2` instance in place (idempotent). Adds:

- `tf2.parseDynamicRecipe(toolItemId)` — looks the item up in `tf2.backpack` and calls `parseRecipe`.
- `tf2.fulfillDynamicRecipe(toolItemId, assignments, options?)` — **Validates every input and weaponChoice slot against `tf2.backpack` before sending anything**; if anything required is missing, it resolves `{ sent: false, missing: [...], warnings: [...] }` without touching the network. On success it sends and resolves `{ sent: true, acknowledged, timedOut, raw, warnings, inventoryEvents, recipe }`. Also emits `tf2.emit('dynamicRecipeFulfillResult', result)` with the same object. **`acknowledged: true` means a response arrived, not that the craft succeeded** — see the unconfirmed-response-schema caveat above.

## Tests

```
npm test
```

61 tests, all pure logic — no network, no live Steam session. The recipe-parsing tests run against real captured bytes (`test/fixtures/realFabricators.js`), not synthetic data. The network-layer tests (`test/dynamicRecipeClient.test.js`) use a stubbed `_steam.sendToGC`, not a real connection. The interactive weapon-picking prompt (`collectWeaponChoices`) takes an injectable `askFn` so it's tested without touching stdin.

## `scripts/dump-fabricator.js`

Read-only diagnostic: logs into Steam, connects to the TF2 GC, and dumps the raw + decoded attribute structure of anything in the backpack with a 2000-2009 attribute. Never sends `FulfillDynamicRecipeComponent`. Used to build the real fixtures above.

## `scripts/dump-item.js <itemId>`

Read-only diagnostic: dumps every raw attribute of one specific backpack item by id (`def_index`, `value`, `value` reinterpreted as float32, and `value_bytes` hex if present). Used to settle exactly this kind of question empirically instead of guessing from schema names — e.g. it's how the killstreak-tier `value_bytes` encoding above was confirmed. Reach for this whenever a new attribute's real wire encoding needs verifying against something in your own backpack.

## `scripts/fulfill-recipe.js`

The live-test harness for the real craft: logs in, lists dynamic recipe items in your backpack **with a full summary per item** (category from tool def_index, output itemdef, every input's itemdef+quantity, and any weapon requirement) so you never pick blind, lets you pick one, auto-matches robot-part-style components by scanning your backpack (greedy, largest stack first, never double-books the same stack across two slots), and for any `weaponChoice` slot **shows you a numbered list of candidate weapons from your own backpack and asks you to pick by index — never a raw item id**. It then re-validates everything, prints the full plan (what gets consumed, what the output looks like, and any warnings it can't verify itself), and **requires you to type `CONFIRMAR` before sending anything**. `tf2.on('debug', ...)` is always logged so you can see immediately whether the response is job-correlated or unsolicited (README "Next steps", item 1).

```
node scripts/fulfill-recipe.js             interactive; asks for typed confirmation before sending
node scripts/fulfill-recipe.js --dry-run   parses + plans + validates, never asks to confirm, never sends
```

Its allocation logic (`selectComponentsForSlot`, `buildPlan`) is unit-tested in `test/fulfillRecipeScript.test.js`, including the double-booking safeguard and shortfall reporting.

### The weapon picker

Candidate weapons are found by scanning `tf2.backpack` for **Unique quality** (6) items whose `item_slot` (from TF2's own item schema) is `primary`, `secondary`, or `melee` — killstreak kits don't apply to cosmetics, PDAs, buildings, or action items, so those are excluded. That part is a confident, schema-backed filter.

Whether a candidate already has the right kit tier applied **is now confirmed**, not just schema-grounded: killstreak tier lives in the weapon's own attribute 2025, and — verified against a real dumped Killstreak Mantreads (tier 1) — the value is in that attribute's **`value_bytes`, as a little-endian float32** (`0000803f` = `1.0` = tier 1), not in the `value` field (which came back `null` on the real item; the first version of this detector read `value` and silently found nothing on every candidate). Tier 2 (Specialized) and 3 (Professional) are only *presumed* to be the standard float32 bit patterns for `2.0`/`3.0` — only tier 1 has actually been observed. A weapon with no killstreak kit at all simply has no attribute 2025.

Candidates are still never hard-excluded by detected tier — a wrong detection would otherwise hide a real weapon from the list, which is worse than an extra line of noise. Instead, whichever candidates match the Fabricator's required tier (1 for Specialized, 2 for Professional — from `REQUIRED_WEAPON_TIER_BY_TOOL_DEFINDEX`) are **sorted first and marked `✓ tier N - cumple el requisito`**; the rest show either the detected-but-non-matching tier or `sin killstreak detectado`. You still make the final call.

Display names come from TF2's item schema (`item_name` token) resolved against an **unofficial mirror of Valve's English lang file**, fetched once at startup over HTTPS from `raw.githubusercontent.com/SteamDatabase/GameTracking-TF2` — this is a real runtime network dependency, purely for display, that can fail or the file can move; if it does, names fall back to a humanized internal dev name (`TF_WEAPON_FIREAXE` → `Fireaxe`) or, failing that, the bare defindex. Nothing about what gets sent to the GC depends on this lookup succeeding.

## Next steps (needs a real craft to resolve)

When you're ready to spend the robot parts on a real Professional/Specialized Killstreak Kit Fabricator, here's what a live run needs to establish, in order:

1. Watch `tf2.on('debug', ...)` while calling `fulfillDynamicRecipe`. If you see `"Got unhandled GC message FulfillDynamicRecipeComponentResponse"`, the response is unsolicited/broadcast (like `CraftResponse`), not job-correlated — the job-callback path in `dynamicRecipeClient.js` will need to be replaced with a handler registered on `Language.FulfillDynamicRecipeComponentResponse` instead.
2. Whichever path fires, dump the raw response buffer's hex — that's the only way to find out if `CMsgFulfillDynamicRecipeComponentResponse` has a real schema (likely just an EResult, but unconfirmed).
3. Check `inventoryEvents` on the result: does `itemChanged`/`itemRemoved` fire for the consumed robot parts and weapon(s), and `itemAcquired` for the new Kit? This is probably the most reliable success signal regardless of what the Response payload turns out to contain.
4. Confirm whether a single stacked item per slot is enough (leading hypothesis) for robot-part slots, or whether the GC expects it split differently. Separately: for the weaponChoice slot on a Professional Fabricator, confirm that sending 2 separate `CMsgRecipeComponent` entries that share the same `attribute_index` (2000) with 2 different `subject_item_id`s is actually the right shape — untested at the wire level, only encode/decode round-tripped.
5. Verify the weapon-count/kit-tier mapping documented above (1 weapon w/ normal Kit for Specialized, 2 weapons w/ Specialized Kit for Professional) holds for the *specific* Fabricator you're testing — it was confirmed empirically but only on the instances tested so far.

I'm not marking `fulfillDynamicRecipe` "done" in the sense of "known to work" — only "implemented against everything that's confirmable without spending real items."
