# Verification for version 0.1.0

## Choice debugger (2026-10-17)

The shared web/native reader has a Debug choices toggle, initially off. Choice inspection runs against an isolated copy of the scene variables and indentation bookkeeping. It reads option source, preserves original engine options where available, and reports inline and block conditions, elseif/else branch requirements, selectable conditions, reuse restrictions, and multi-group paths. Unknown conditions stay marked unknown. It does not run option bodies or modify eligibility variables. Turning debug off restores the original controls without replaying the page.

Hidden and disabled choices have an explicit Force-select button. Selection invokes the engine's normal resolution callback; fake-choice exit boundaries include the otherwise hidden options. Tests cover a fully unavailable menu, unrelated parse errors, message source checks, normal-control restoration including submit buttons outside forms, unchanged save history when toggling, and continued autosaving after selection. The supplied APK's full parser and resolution implementation also pass a hidden fake-choice regression test.

In Magikiras 1.0.9, the browser test progressed through radio choices, name inputs, text continuations, and combat menus. Debug mode exposed the normally hidden relationship choice guarded by `morgan = "crush"`, reported false, and successfully followed its story when forced. Toggling off restored the two original options. Saving and resuming the forced branch restored its story without runtime warnings or console errors. The updated demo also displayed and force-selected a disabled option. At a 375px viewport, the toolbar controls stayed within the page width. All 113 tests pass with both private-APK checks enabled. This is a browser smoke test of the shared runtime; iOS device checks still require a native build.

Syntax checks, the final web build, native asset sync, and native metadata/export/storage bridge verification pass on Windows. The shared runtime and choice inspector are bundled into the iOS project; Swift compilation and device checks require macOS/Xcode.

## Autosave history (2026-10-17)

Plain page-break continuations skip autosaving when only the instruction position changes. The runtime tracks the engine callbacks, so choices and character input still save even when their submit button is labeled “Next”; custom page-break captions count as continuations. State, scene, or in-game save-slot changes still create snapshots. Closing the player after a plain continuation also skips the extra snapshot.

The save list supports individual selection, Select all, a selected count, and a confirmation listing the chosen snapshots. Batch deletion validates game ownership before deleting and commits in one transaction. Tests cover cancellation, retaining selection after failure, clearing selection on game changes, and rollback in both IndexedDB and native storage. Installed versions and unselected saves remain intact.

Autosave duplicate detection starts from the opened save and compares values regardless of JSON object key order. It ignores engine build/restore metadata, capture times, previews, recovery checkpoint metadata, and the engine's current-page, temporary stats, and backup storage caches. Full storage and state remain in new snapshots; player-created in-game save slots still trigger persistence. Named snapshots remain explicit copies. Save rows identify automatic snapshots and show a story preview when available, scene/line position, and timestamps including seconds.

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
