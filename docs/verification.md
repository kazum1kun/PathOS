# Verification for version 0.1.0

## Removing imported versions (2026-10-27)

Each installed version has a Remove action with a confirmation. While another version remains, removal frees package files and preserves saves plus compact source fingerprints. Saved progress can migrate to a compatible installed version or reconnect to the original version when its package is reimported. The active version switches to a remaining package. Removing the final package deletes the game, all saved progress, and retained source metadata in one transaction. The empty library remains usable, and other games are unaffected.

The suite passes 131 tests with three optional private-game checks skipped. Automated coverage exercises cancellation, storage failures, active-version replacement, save retention and migration, reimport, compressed backup restore, final-version cleanup, unrelated games, and rollback in both browser and native backends. A stale confirmation cannot delete the final version and its saves without explicit game-removal confirmation. Browser checks verified the Versions action on desktop and the final-version confirmation at 390px width; cancelling kept the demo and all three saves, with no console warnings or errors. Native filesystem tests also cover releasing removed-version assets and retaining them on rollback; those Swift tests require macOS.

## Compressed exports and compact saves (2026-10-27)

Backups use a version-2 ZIP manifest with raw binary assets, DEFLATE compression, and SHA-256 references that deduplicate identical files across installed versions. Individual save exports are compressed ZIP files too. Save records retain state, chapter checkpoints, quick-save slots, and preferences, while dropping duplicate scene source/labels and the engine's regenerable current, temporary, and recovery caches. Existing stored saves compact atomically when the app opens.

The suite passes 125 tests with three optional private-game checks skipped. Coverage includes exact binary backup restore, asset deduplication and checksums, archive limits and corruption, save import, preserving progress and quickslots, idempotent compaction, and rollback on failure. Browser checks imported the built-in demo, saved progress, downloaded both ZIP formats, reimported the save, and restored the backup without console warnings or errors. The one-version/two-save demo backup was 3,913 bytes versus 12,867 bytes for equivalent pretty-printed base64 JSON; its individual save was 743 bytes. Results depend on game content, especially compressed artwork/audio. Web syntax/build and native injected-bridge checks pass; Swift compilation and iOS share-sheet testing still require macOS/Xcode.

## Local APK content (2026-10-21)

The shared runtime now answers APK purchase checks from bundled content availability. Products with chapter mappings are available only when every mapped chapter is present; base-game and fake product markers are also supported. Checks remain asynchronous, notify engine purchase subscriptions, and report billing unavailable. APK chapters load from local assets instead of the authenticated web scene cache. Browser/native isolation and network restrictions remain in place; no store receipt is created or transferred, and missing content cannot be downloaded. ZIP exports keep their own billing behavior. This supersedes the trial-mode limitations recorded in the earlier compatibility and artwork checks below.

Archive imports record APK/ZIP provenance. Earlier APK imports are recognized through their package metadata or original filename without re-importing. Resuming refreshes cached purchase-check flags on a copy of the selected state, leaving the saved record intact.

Private checks imported the supplied Magikiras 1.0.9 and Choice of the Vampire 3.0.12 APKs. Their original `Scene.check_purchase` commands reported the bundled products available, including Vampire's adfree, Memphis and St. Louis products. Their original `loadSceneFast` implementations successfully loaded every mapped paid chapter from the virtual filesystem without invoking the online paid-scene cache. Regression tests also cover partial archives, unmapped products, compiled scenes, earlier APK metadata, ZIP behavior and stale trial flags on resume. Set `PATHOS_CONTENT_APKS` to a JSON array of private APK paths to run this optional check; the APKs and extracted story files are not tracked.

In the browser, Vampire started directly at its content warning without the prior Buy/Restore/Play for Free screen, then showed its New Orleans artwork. A named snapshot reopened at the same illustrated page after reloading the app, with no console warnings or errors. All 123 tests passed with private APK/engine checks enabled. Syntax checks, the web build, native asset sync and native metadata/bridge verification passed on Windows. Swift compilation and an iOS device smoke test still require macOS/Xcode. No nightly build was triggered.

## Bundled artwork

Choice of the Vampire 3.0.12 reproduced a bundled-image failure: `stats_header.png` resolved to a parent-created blob URL, but the opaque game frame reported a complete image with zero natural width/height. Bundled image resources now use data URLs with their original MIME type and exact bytes, matching the existing treatment of scripts and stylesheets. The change covers static HTML, CSS image references, and dynamic source assignments from `*image`/`*text_image`, including hash query strings. Origin isolation and network restrictions remain in place.

The supplied APK's stats header loaded at 600×110 after the change. Its New Orleans chapter illustration loaded at 1200×900, and the chapter title loaded at 600×167. Both chapter images also loaded after saving and resuming. The browser reported no runtime warnings or console errors during the fixed-image smoke test. External store badges are not bundled and remain blocked. No commercial artwork or APK assets are tracked in the repository.

The APK's own startup screen offers the first two volumes for free. Android receipts and native billing/modifications are unavailable in PathOS's browser fallback; the game's trial and purchase checks are preserved. The image fix does not change purchase status or provide a billing/restore service.

All 118 tests pass, including the optional private engine checks. New coverage verifies original PNG/SVG bytes, MIME types, CSS references, dynamic image properties, and blocked remote image requests. Syntax checks, web build, native asset sync, and metadata/bridge verification pass locally. This is a shared-runtime browser check; iOS device behavior and Swift compilation still require macOS/Xcode.

## Mobile navigation and controls

At widths up to 860px, the shared web/native layout uses a labeled Menu disclosure for library tools and a separate Tools disclosure in the reader. The library menu includes APK/ZIP import, save import with the selected game's name, backup export/restore, storage, and Help. Import save is also visible directly in the Saves tab. Search is available on phones, save-row actions use two columns, and phone controls have at least 44px tap targets. Coarse-pointer devices also retain large targets at wider widths. Safe-area padding and scrollable menus/dialogs keep short or notched screens usable.

Menu tests verify existing file-input routing, selected-game context, importing while bulk selection is active, disabled save import without an installed game, outside-click/Escape dismissal, and reader save/debug access without extra autosaves. The service worker keeps navigation HTML and assets within the active build's cache, avoiding mixed old scripts/new markup while an update waits to activate.

Browser checks with the demo covered 320, 375, 430, 600, 768, 860, 861, and 1280px widths. Save import, selection/deletion controls, row actions, and reader actions stayed inside the page width. The phone Import save button opened the file picker. The Menu disclosure exposed Restore backup and selected-game save import; reader Tools exposed status, snapshot creation, and debugging. Escape returned focus to the trigger. Bulk-delete review and cancellation retained the selected save. No browser data was deleted during these checks.

All 116 tests pass, including both optional supplied-APK engine checks. Syntax checks, web build, native asset sync, and metadata/bridge verification pass on Windows. Responsive browser checks are not a real iOS device or Swift compilation test.

## Choice debugger (2026-10-17)

The shared web/native reader has a Debug choices toggle, initially off. Choice inspection runs against an isolated copy of the scene variables and indentation bookkeeping. It reads option source, preserves original engine options where available, and reports inline and block conditions, elseif/else branch requirements, selectable conditions, reuse restrictions, and multi-group paths. Unknown conditions stay marked unknown. It does not run option bodies or modify eligibility variables. Turning debug off restores the original controls without replaying the page.

Hidden and disabled choices have an explicit Force-select button. Selection invokes the engine's normal resolution callback; fake-choice exit boundaries include the otherwise hidden options. Tests cover a fully unavailable menu, unrelated parse errors, message source checks, normal-control restoration including submit buttons outside forms, unchanged save history when toggling, and continued autosaving after selection. The supplied APK's full parser and resolution implementation also pass a hidden fake-choice regression test.

In Magikiras 1.0.9, the browser test progressed through radio choices, name inputs, text continuations, and combat menus. Debug mode exposed the normally hidden relationship choice guarded by `morgan = "crush"`, reported false, and successfully followed its story when forced. Toggling off restored the two original options. Saving and resuming the forced branch restored its story without runtime warnings or console errors. The updated demo also displayed and force-selected a disabled option. At a 375px viewport, the toolbar controls stayed within the page width. All 113 tests pass with both private-APK checks enabled. This is a browser smoke test of the shared runtime; iOS device checks still require a native build.

Syntax checks, the final web build, native asset sync, and native metadata/export/storage bridge verification pass on Windows. The shared runtime and choice inspector are bundled into the iOS project; Swift compilation and device checks require macOS/Xcode.

## Autosave history (2026-10-17)

Plain page-break continuations skip autosaving when only the instruction position changes. The runtime tracks the engine callbacks, so choices and character input still save even when their submit button is labeled “Next”; custom page-break captions count as continuations. State, scene, or in-game save-slot changes still create snapshots. Closing the player after a plain continuation also skips the extra snapshot.

The save list supports individual selection, Select all, a selected count, and a confirmation listing the chosen snapshots. Batch deletion validates game ownership before deleting and commits in one transaction. Tests cover cancellation, retaining selection after failure, clearing selection on game changes, and rollback in both IndexedDB and native storage. Installed versions and unselected saves remain intact.

Autosave duplicate detection starts from the opened save and compares values regardless of JSON object key order. It ignores engine build/restore metadata, capture times, previews, recovery checkpoint metadata, and the engine's current-page, temporary stats, and backup storage caches. Portable state, chapter checkpoints, preferences, and player-created in-game save slots remain in new snapshots; regenerable engine caches and chapter source copies are removed. Named snapshots remain explicit copies. Save rows identify automatic snapshots and show a story preview when available, scene/line position, and timestamps including seconds.

In the Magikiras browser test, the same 19 saved IDs remained after resume, stats, return, close, and a second resume/close cycle. Advancing a choice added exactly one new save, including a readable preview; closing added none. Existing saved history was retained. A subsequent test in a separate local library retained the same two saved IDs after the “April 4th, 2050” continuation and close; choosing a radio option and submitting “Next” added exactly one save. Selecting two saves showed the selected count and a confirmation containing those two records; canceling retained the selection. All 106 automated tests pass, including the supplied APK's engine helpers.

Syntax checks, the web build, Capacitor sync, and native metadata/bridge verification pass. The synced app, runtime, and storage modules match the source files. Real-device checks and Swift compilation still require macOS/Xcode.

## Android APK compatibility (2026-10-17)

The shared player keeps native Android/iOS/omnibus flags disabled so APKs use their bundled engine's browser/offline fallbacks. It embeds scripts and stylesheets as data URLs and permits local form submit handlers for character text and number inputs. The game frame retains its opaque origin, native-bridge restrictions, network CSP, and blocked form navigation. The engine and its purchase checks are not replaced; Android billing, receipt restoration, and other original-app native features remain unavailable.

The supplied Magikiras 1.0.9 APK was imported and tested in the desktop browser using the shared runtime. Startup, progression into Chapter01, radio choices, first/last name entry, stats and return to the game, automatic saves, and named snapshots worked. After closing and reopening the app, a named snapshot restored the same choice page, with no runtime warning or console error. Embedded styles also fixed the accumulating old controls caused by missing page animations. This was an early-game smoke test, not a complete playthrough or an iOS device test. No game assets are included in the repository.

The Android compatibility update passed all 96 tests available at that point, including this APK's extracted `computeCookie` and `restoreGame` helpers with `PATHOS_APK_HTML` pointing to its `util.js`. Web build, Capacitor sync, and native metadata/bridge checks pass locally. Swift compilation and device checks still require macOS/Xcode.

## Native storage

The native-storage update passes 86 automated tests, with one optional private-APK engine test skipped. The additional checks cover automatic native migration, rollback on write/commit failure, retaining the original IndexedDB copy, reopening without resurrecting deleted data, save retention, native JSON key reordering, and portable binary backups. Host UI tests cover the iPhone/iPad Home Screen instructions and native durable-storage status. Syntax checks, web build, Capacitor sync, and injected export/storage bridge verification pass on Windows.

`ios-native/scripts/test-storage.sh` compiles the actual `VaultStore.swift` implementation and runs SQLite/filesystem integration checks on macOS. The native `verify` command runs it automatically on macOS, including in the existing iOS build workflows. This runner, full Swift/iOS compilation, and real-device migration still need macOS/Xcode; they were not run in the Windows workspace.

## Earlier baseline

On 2026-10-16, the automated suite passed all 71 tests, including the optional test against the uploaded DinoKnights engine helpers. The real APK also passed archive inspection, with 21 playable assets and 19 indexed scenes. No commercial game assets are included in this project.

The tests cover:

- Archive parsing and size limits, and ZIP decoding in browser mode
- Local asset requests
- State capture at each page and restoring it
- Compatibility across versions
- Importing legacy saves
- Isolated game storage
- Edits that never change the original save
- Atomic backups
- Data persisting after the database is reopened
- The host UI flows

The host UI tests use a DOM implementation and a mocked frame boundary. The database tests use a faithful IndexedDB implementation. The runtime tests run the bridge and the actual extracted save and restore helpers in a JavaScript VM.

`npm run check`, `npm run build`, and the native project's `npm run sync` and `npm run verify` all passed. The native checks cover export results, cancellation, errors, and the frame and origin restrictions. They also verify the project metadata and pinned dependencies.

This environment had no browser for interactive testing and no Mac or Xcode. The deployed web app, a full playthrough in Safari, Firefox, and Chrome, Swift compilation, and behavior on a real iPhone or iPad still need a smoke test. In particular, check:

- Launching offline
- Importing from the Files app
- Image and audio assets
- Backgrounding and resuming
- Exporting through the share sheet
- Installing a new app build without losing the existing library

The iOS deliverable is source code and an Xcode project, not a signed IPA.

To run the standard suite:

```sh
npm ci
npm run check
npm test
npm run build
```

To run the optional real-engine test, set `PATHOS_APK_HTML` to an extracted ChoiceScript file containing both `computeCookie` and `restoreGame`, such as a compiled `index.html` or the Magikiras `util.js`. Without that private file the test is skipped, and all the synthetic and host integration tests still run.

For the full choice-parser regression, also set `PATHOS_APK_SCENE` to the extracted `scene.js`, with `PATHOS_APK_HTML` pointing to the matching `util.js`. These private engine files stay outside version control.
