This is deep in-development stuff and mostly related to the (also in-development) Fingal game engine, so you can definitely ignore this unless you're really interested!

# Maps, characters and Fingal stories

Keep the `.verwrity.zip` as your main writing project. It holds the manuscript, wiki, history, planning, maps and character records together. A Fingal export is a separate starting world for a game. It doesn't replace the full project.

You can plan locations and characters while writing, then adapt them for Fingal if you want. The Wiki can help prepare notes from the manuscript, with sources and your own text kept distinct. Starting locations and equipment describe the beginning of a game, not a player's current position, inventory, knowledge or save.

## Turn on the tools you want

Open **Settings → Prototype features**. **Map editor** and **Game character sheets** can be enabled separately, including for ordinary novels and RPG fiction. **Enable Fingal mode** includes both, item forms and reviewed story imports/exports. Everything starts off. Turn a feature off and its controls disappear, but the records stay in your project for when you turn it back on.

**Map** replaces the centre manuscript view. The left column lists maps and locations, with the wiki still on the right. **Back to manuscript** returns to your writing with its text, comments, selection and undo history still there. Switching views doesn't change your saved Focus or Typewriter layouts.

## Keep records alongside wiki notes

A character or location has a form beside its ordinary wiki notes. You can add a record to an existing page. If a new name matches an existing title or alias, **Use existing page** keeps that page's notes, identity and history instead of making a duplicate. An existing record opens with the values you've already set.

Wiki links keep working when you rename a page. They connect characters to starting locations, map cells to location pages, routes to destinations and character bonds to other characters. The editable Fingal IDs are separate names used by the game files.

Saving a record leaves the manuscript, wiki text and its authorship marks alone. The old record goes into wiki History. Restoring a page version restores its record too, provided the references still make sense. Record history is separate from a scene's prose checkpoints. Questions can use records as background, but a manuscript citation still has to point to words in the manuscript.

## Maps and locations

Create more than one map if you need them. Click an empty cell to add a location; click a location or resident character to open their wiki page. **Edit map location** lets you set coordinates, descriptions, items, compass routes and travel minutes, interior links and additional facts. Choose each map's initial location too.

Routes can cross maps. You'll need to create each route, including a return route if you want one: nearby cells don't automatically get a road between them. Before removing a location, change any routes, character starts or map starts that still point to it. Only empty maps can be deleted.

## Characters and items

Character forms cover identity, description, backstory, role, starting location, nature/alignment, attributes, factions, stats, combat style, equipment, behaviour, social preferences, goals, bonds, needs and private facts. Fill in what's useful for your story. People have contextual behaviour and **Not applicable** alignment; **Good/Evil** is available for authored creatures.

Fingal mode adds item definitions for portability, prices and currencies, weapons, armour, consumables, containers, tags and stats. When a character or location refers to an item, use its definition ID. You can work through the forms without making raw JSON your main editing surface.

## Import a Fingal world

With Fingal mode on, open **File operations → Review import** and choose a format-1 Fingal story JSON file. Check the counts and warnings before confirming. Verwrity saves your current scene, wiki and record edits first, then creates a separate project. If that save fails, your text stays available.

Imported worlds have no invented prose scenes. NPCs, player templates, locations and items become wiki records with blank note bodies; their imported descriptions stay in the record fields. The complete original JSON is kept, readable, in your Verwrity archive, with a record of where it came from. Later changes you make are recorded separately. Unfamiliar extensions and economy data are kept even where there isn't a dedicated editing form. Fingal's live catalogues and playthrough saves aren't changed.

Import accepts UTF-8 JSON up to 8 MB. It checks for duplicate keys, invalid numbers, broken links and the authoring limits: 32 maps, coordinate spans of 61 cells, separate occupied cells and limits on field/list sizes. A native file outside those limits may need adapting before import; you'll get an explanation rather than rounded coordinates or quietly discarded data. Fractional coordinates stay exact. Dense fractional maps use a location list instead of a huge grid.

## Export a starting world

Open **Review export** and check any reported problems. Each map needs an initial location, player templates must be marked, and referenced items and currencies must exist. The review also checks links, field limits and the IDs the game file will use. New map titles become valid Fingal IDs; location IDs get map prefixes. You'll see the mapping before downloading.

**Download Fingal story** produces a starting world, without manuscript or wiki prose and without a playthrough save. Unchanged imported values keep their original extensions and omitted defaults. Your edited fields replace those parts of the original, keeping nested data they don't change. References to wiki pages become the current Fingal IDs.

A review lasts an hour and applies to this project and session. If the world changes, review it again. Export doesn't change your main project or save its named archive, so save that separately too.

## Saving and moving the project

Current Verwrity archives use version 10; versions 1–9 still open. Earlier projects without world data open as ordinary wiki pages with no maps. Named saves, recovery, duplication and portable exports keep the maps, page links, records and imported source, including while the tools are disabled. You can always keep writing with the optional world tools off.
