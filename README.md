# AutoRecipe

Completes TF2 "dynamic recipes" — Killstreak Kit Fabricators, and in theory Chemistry Sets — via the Game Coordinator, using `tf2` (node-tf2) v4 + `steam-user` v5.

## Why this exists

Dynamic recipes don't use TF2's normal crafting message. They use `FulfillDynamicRecipeComponent` (GC message 1085), which node-tf2 does not implement. [Issue #6](https://github.com/DoctorMcKay/node-tf2/issues/6) has been open since 2015 asking for it; a 2015 PR by jamtat attempted it but was never merged and targets an API that no longer exists (`steam.toGC`, `steam.on('fromGC')`).

AutoRecipe implements it against the current API, extending a `TeamFortress2` instance at runtime.

## Status

| | |
|---|---|
| Specialized Fabricators | ✅ Confirmed working against a real craft |
| Professional Fabricators | ⚠️ Untested (needs 2 weapons at the same slot) |
| Chemistry Sets | ⚠️ Untested — same GC message in theory, never run against one |

This consumes real items. The Specialized path is the only one confirmed end-to-end. Don't assume the others work.

## Install

```
npm install
```

## Usage

```
node scripts/fulfill-recipe.js --dry-run   # plans and validates, sends nothing
node scripts/fulfill-recipe.js             # asks for typed confirmation before sending
```

Lists the dynamic recipe items in your backpack with a readable summary (category, output, required parts by name), auto-matches robot parts from your inventory, asks you to pick the weapon(s) by index, prints the full plan, and requires typing `CONFIRMAR` before anything is sent.

Always run `--dry-run` first. It shows exactly what would be consumed and what's missing, without touching the network.

Credentials are read from `STEAM_USERNAME` / `STEAM_PASSWORD` env vars, or prompted. Nothing is stored.

## Weapon requirements

Fabricators consume weapons as inputs. This is not validated by the library — verify by hand:

- **Specialized**: 1 Unique weapon with a normal (tier 1) Killstreak Kit already applied.
- **Professional**: 2 Unique weapons with a Specialized Killstreak Kit already applied.

The weapon picker detects and marks the tier of your candidates, but never hides any — you make the final call. (Tier 1 detection is confirmed against a real weapon; tiers 2/3 are presumed.)

## Diagnostics

Read-only, send nothing:

```
node scripts/dump-fabricator.js       # dumps raw + decoded structure of any dynamic recipe item
node scripts/dump-item.js <itemId>    # dumps every raw attribute of one item
node scripts/robot-part-names.js      # prints the itemdef → name table for robot parts
```

## API

```js
const { parseRecipe } = require('./lib/parseRecipe.js');
const { validateAssignments, buildFulfillPayload } = require('./lib/fulfillRecipe.js');
const { attachDynamicRecipeSupport } = require('./lib/dynamicRecipeClient.js');
const { robotPartName } = require('./lib/robotPartCatalog.js');
```

`parseRecipe(item)` — pure function. Takes a backpack item, returns its slots:

```js
{
  toolItemId, toolDefIndex,
  inputs: [{ attributeIndex, itemDefIndex, quality, quantityRequired, ... }],
  weaponChoices: [{ ...same shape, itemDefIndex: 0 }],
  output: { ...same shape },
  attributeSlots: [...],   // itemdef-0 slots of unconfirmed purpose, never sent
  slots: [...all, sorted by attributeIndex],
}
```

`validateAssignments(recipe, assignments, backpack)` — returns `{ ok, missing, warnings }`. `assignments` is `{ [attributeIndex]: itemId | itemId[] }`. `missing` blocks sending; `warnings` flags what can't be checked automatically (the weapon kit-tier precondition).

`buildFulfillPayload(toolItemId, recipe, assignments)` — encodes the GC message.

`attachDynamicRecipeSupport(tf2)` — extends a live instance (idempotent). Adds:

- `tf2.parseDynamicRecipe(toolItemId)`
- `tf2.fulfillDynamicRecipe(toolItemId, assignments, options?)` — validates against the backpack first and never sends if anything is missing. Resolves `{ sent, acknowledged, timedOut, raw, warnings, inventoryEvents, recipe }`.

`acknowledged: true` means a response arrived, not that the craft succeeded. `inventoryEvents` is the reliable success signal — see below.

`robotPartName(itemDefIndex)` — maps a robot part itemdef (5700-5707) to its market name, `null` otherwise.

## Protocol notes

What was reverse-engineered, since none of this is documented:

- `FulfillDynamicRecipeComponent` = GC msg 1085. `CMsgFulfillDynamicRecipeComponent { tool_item_id, consumption_components: [CMsgRecipeComponent{ subject_item_id, attribute_index }] }`.
- Recipe slots live at item attribute defindex 2000-2009. Each slot's `value_bytes` decodes as `CAttribute_DynamicRecipeComponent`, not the `_COMPAT_NEVER_SERIALIZE_THIS_OUT` variant (which mis-parses `num_required` into the wrong field).
- There is no `is_output` field. The output is the highest-numbered slot present — inferred from real samples, not from any documented flag.
- A slot with `itemDefIndex` 0 carrying attribute 2025 ("killstreak tier") is a weapon requirement, not ignorable metadata. It consumes `num_required` freely-chosen weapons (1 for Specialized, 2 for Professional), sent as ordinary components against that slot.
- A slot needing N units takes N separate components, each with its own `subject_item_id`. Confirmed with 29 individual robot parts. Whether a single stacked item with `quantity >= N` also works is unknown.
- Killstreak tier on a weapon lives in attribute 2025's `value_bytes` as a little-endian float32 (`0000803f` = `1.0` = tier 1) — not in the `value` field, which comes back `null`.
- `attributes_string` is pipe-separated tokens, where each gap between real tokens holds the 4-byte filler `\x01\x02\x01\x03` twice.
- `FulfillDynamicRecipeComponentResponse` (msg 1086) has no confirmed schema. No protobuf body exists in any available `.proto`, and neither do its sibling action-response messages. Success is confirmed via `inventoryEvents` (consumed items disappearing, output appearing), not by decoding the response.

## Known unknowns

- Professional Fabricators — 2 components sharing one `attribute_index`, never sent for real.
- Killstreak tier 2/3 detection — presumed float32 pattern, only tier 1 observed.
- Chemistry Sets — theoretical.
- Response msg 1086 — format unknown, and unclear whether it's job-correlated or broadcast.
- Bulk-stacked items for a slot — never exercised.

## License

ISC.
