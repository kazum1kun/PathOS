# PathOS for iOS

This folder holds the native shell for the shared web app, plus a generated Xcode project with a few custom changes. Build `../dist` first, then run these commands from this folder:

```sh
npm ci
npm run sync
npm run verify
npm run open
```

You need Node.js 22+ and Xcode 26+ on macOS. The deployment target is iOS 15+. Choose your signing team in Xcode. Full instructions and the limits of native testing are in [`../docs/ios.md`](../docs/ios.md).

The web bundle and the game and save logic are shared with the website. `VaultBridgeViewController.swift` adds share-sheet export and only lets the trusted main library frame use native messaging. The native origin is fixed at `capacitor://localhost`, and the bundle ID is `com.swsoftworks.pathos`.

Don't regenerate the platform with `cap add ios`. The included SceneDelegate, storyboard, and project are wired to the custom controller. `cap sync ios` updates assets and dependencies without touching that native code.

Capacitor is MIT-licensed; see `LICENSE-Capacitor.txt`. Its Cordova support comes through the generated Swift Package Manager dependency and keeps its upstream license.
