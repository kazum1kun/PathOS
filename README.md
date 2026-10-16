# PathOS

PathOS is a personal ChoiceScript library for the web and iOS. Import an APK or ZIP that contains a complete ChoiceScript web game, play it in a sandboxed frame, view and edit your saves, and keep older versions of a game when it gets an update.

The website and the iOS app share the same JavaScript importer, player, save model, and interface. The iOS app is a Capacitor 8.5.3 shell that adds exporting through the native share sheet. This repository doesn't include any commercial games or APK assets.

## Run the website

```sh
npm run build
python3 -m http.server 8000 --directory dist
```

Open `http://localhost:8000`. For production, deploy `dist/` to a stable HTTPS address. Package inspection and gameplay happen entirely on the device, so there's no upload server to run. See [web deployment](docs/deployment.md).

## Build the iOS app

On a Mac with Node.js 22+ and Xcode 26+:

```sh
npm run build
cd ios-native
npm ci
npm run sync
npm run verify
npm run open
```

In Xcode, choose your signing team and run the `App` scheme. The project targets iOS and iPadOS 15+. See [iOS build and verification](docs/ios.md). This repository contains the source and an Xcode project, not a signed IPA, and the app hasn't been tested on a real device yet.

## Game updates

Each save belongs to a game in your library and remembers the exact version that created it. Import a newer APK into the same game, and all of its saves stay together. If the update is compatible, PathOS resumes from a migrated copy of your save. If the chapter you were in has changed, you can keep playing on the original version, or replay that chapter from its start if a checkpoint is available. Your original save is never modified.

These are structural checks, so they can't catch every change an author makes to the story's logic. See [save compatibility](docs/save-compatibility.md) for the exact rules and what's supported.

## Backups

Export a full JSON backup of your library to move games and saves between a browser and the iOS app. PathOS keeps the 20 most recent automatic saves for each installed version, and keeps manual and edited saves separately. Editing a save always creates a copy. You can also import raw ChoiceScript saves and save bundles from the DinoKnights editor by choosing the installed version they came from. The browser and the iOS app have separate storage, and this release has no cloud sync.

## Development

```sh
npm ci
npm run check
npm test
npm run build
```

The web build has no install-time dependencies. The ZIP reader is vendored in `src/vendor/` along with its license. Test dependencies are development-only, and native dependencies are pinned separately under `ios-native/`.

| Path | Contents |
| --- | --- |
| `src/importer.js` | APK/ZIP validation, metadata, assets, and scene indexing |
| `src/runtime.js` | Sandboxed player, local assets, and ChoiceScript state hooks |
| `src/storage.js` | Transactional IndexedDB storage and backup import/export |
| `src/compatibility.js` | Update checks, save migration, copies, and checkpoints |
| `src/app.js` | Shared library and editor interface |
| `dist/` | Deployable static website |
| `ios-native/` | Capacitor configuration, pinned dependencies, and Xcode project |
| `tests/` | Importer, state, migration, backup, and runtime checks |

To try the app without a game of your own, choose **Explore with a demo** for a short original story. Not every APK will work: the package must contain a complete ChoiceScript web game, and the player can't run Android bytecode or native plugins.
