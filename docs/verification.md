# Verification for version 0.1.0

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

To run the optional real-engine test, set `PATHOS_APK_HTML` to the path of an extracted ChoiceScript `index.html`. Without that private file the test is skipped, and all the synthetic and host integration tests still run.
