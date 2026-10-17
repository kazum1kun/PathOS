# Saves when a game changes

Installing a newer APK never replaces a game's saves. PathOS stores each game, each installed version, and each save as a separate record. A save keeps the ID of the version that created it and stays visible when you switch to another version.

## Identity

| Record | Purpose |
| --- | --- |
| Game | A stable library entry shared by every update of the same story |
| Version | The content hash and extracted assets of one imported package |
| Save | The state, variables, local game storage, scene position, and original version |

When they're available, the importer reads the ChoiceScript storage name and the Android package metadata to recognize updates. Filenames and version labels alone aren't enough. If a repackaged APK has different identifiers, link it to the existing game when you import it. Different stories stay separate even if they happen to use the same storage name.

A content hash identifies the extracted, playable assets. Version labels are only descriptive: two files labeled "1.0" can contain different code, and the same playable content can ship under a different Android version number.

## Resuming a save

A ChoiceScript save records a scene and a line position. If a line is inserted into that chapter, the saved position can end up pointing at a different instruction. That's why the player checks the saved scene, and any scenes it will return to, before resuming on changed content.

| Situation | Behavior |
| --- | --- |
| Original package, or identical content | Resume at the saved position |
| Current scene, return scenes, and engine are unchanged | Offer a migrated copy and add defaults for newly declared constant variables |
| Current scene or a return scene changed | Block resuming on that version |
| A variable's type changed | Block migration |
| The return stack can't be read, or checksums are missing | Keep the original version available instead of guessing a line position |
| An eligible chapter-start checkpoint exists | Offer to restart that chapter on the selected version |

Migrating or editing a save creates a new save that links back to its parent, and the original is kept. A migration to changed content, or a chapter restart, begins with empty game storage. Built-in save slots, achievements stored outside the main state, and preferences stay with the original snapshot. This stops an old in-game Load from restoring a stale line number in a changed chapter. Copies to identical content can keep that storage. A chapter restart uses the state captured just before the chapter began and loads the chapter from the selected package. It replays the whole chapter, so you can lose progress made inside it.

These checks confirm that the structure is compatible, not that the story still means the same thing. An author can change what a variable means, or add new story requirements, without changing its type. A chapter restart also doesn't prove that an old playthrough meets every new requirement. Keep the original package and a backup, because some updates do require a new playthrough.

New defaults come from simple ChoiceScript declarations that can be read without running the game. New or changed dynamic initializers, such as arrays and expressions that can't be evaluated safely without running the game, block migration. Engine variants and custom save systems may need extra adapters. When the app hits something it doesn't support, it says so rather than claiming it works with every APK.

## Durable state and backups

The web library uses IndexedDB transactions; the iOS app uses native SQLite transactions with game files in Application Support. Both use the same save validation, merge and retention rules. It keeps the 20 most recent automatic snapshots for each installed version. Named, edited, imported, migrated, and checkpoint saves stay until you delete them. A snapshot is taken as a page is displayed, before its story commands run, so restoring it doesn't apply the same effects twice. That also means the page's commands can adjust a variable you edited when the page replays. Versions are immutable playable packages, and each save contains its own snapshot. A full backup includes the installed assets, saves, and game records, so you can move it between a browser and the iOS app without downloading the same game version again.

A backup restore checks every record and reference before writing anything, and it runs as a single transaction. A malformed or conflicting backup can't partly overwrite your library. Backup JSON is treated purely as data: importing it never runs embedded strings as JavaScript.

The local library isn't a cloud account. Each browser profile, each origin, and the iOS app has its own storage. Export backups regularly, and always before replacing a device, clearing browser data, or uninstalling the app.

## Supported scope

The player supports APK and ZIP archives that contain a complete ChoiceScript web game, including its JavaScript engine and story assets. It doesn't run Android bytecode. Native billing, ads, achievements, Android APIs, downloads that need an account, and arbitrary Cordova plugins aren't available in the player. The app doesn't supply missing or protected content.

Game code runs in an opaque, sandboxed iframe with a local virtual file system and its own storage adapter. It can't reach another game's data or the iOS export bridge. The library imports an archive without running any of its JavaScript.

Archives can be up to 256 MiB compressed and 512 MiB expanded, with at most 64 MiB per file and 20,000 files. ZIP64 and encrypted archives, path traversal, duplicate paths, unsupported compression methods, and symbolic links are rejected. Device memory may set a lower practical limit, especially in mobile browsers.

## Saves from the earlier editor

**Import save** accepts raw ChoiceScript state and the `choicescript-save-bundle-v1` backup from the earlier editor. You choose the original installed package yourself, and a known mismatch in the current scene's CRC is rejected. Before importing, the app tells you about any missing package fingerprints, checksums, or return-location details. This assigns the save to its original version; it doesn't migrate it to an update. Bundle imports are all-or-nothing.
