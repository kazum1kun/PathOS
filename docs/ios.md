# Build the iOS app

The iOS app runs the same `dist/` bundle as the website, inside Capacitor's WKWebView. Importing, playing, saving, update checks, and the save editor all come from the shared JavaScript. The Swift shell adds one thing: exporting through the iOS share sheet. This folder contains a real Xcode project, not a compiled or signed IPA.

## Requirements

You need a Mac with Node.js 22 or newer, Xcode 26 or newer, and the Xcode command line tools. The project targets iOS/iPadOS 15 or newer and pins Capacitor to 8.5.3, following the [Capacitor 8 environment setup](https://capacitorjs.com/docs/getting-started/environment-setup) and [iOS documentation](https://capacitorjs.com/docs/ios).

## Build and install

From the project root:

```sh
npm run build
cd ios-native
npm ci
npm run sync
npm run verify
npm run open
```

Then, in Xcode:

1. Wait for Swift Package Manager to resolve Capacitor.
2. Select the `App` target, open **Signing & Capabilities**, choose your signing team, and turn on automatic signing.
3. Pick an iPhone or iPad simulator, or a connected device, and run the `App` scheme.

The project file is `ios-native/ios/App/App.xcodeproj`. It uses Swift Package Manager, so you don't need CocoaPods. Node dependencies are pinned in `ios-native/package-lock.json`.

You can also check a simulator build from the `ios-native/` folder:

```sh
xcodebuild -resolvePackageDependencies -project ios/App/App.xcodeproj -scheme App
xcodebuild -project ios/App/App.xcodeproj -scheme App -configuration Debug -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO build
```

After changing the shared web code, run `npm run build` in the project root and `npm run sync` in `ios-native/` before building again. Don't run `cap add ios` on this project: it creates a fresh platform folder without the custom Swift code.

## Build on Codemagic

The repository root includes [`codemagic.yaml`](../codemagic.yaml), following Codemagic's [Capacitor workflow](https://docs.codemagic.io/yaml-quick-start/building-an-ionic-app/). PathOS uses Capacitor and Swift Package Manager, so it doesn't need React Native, Expo, CocoaPods, or a generated Xcode workspace. The shared `App` scheme is checked into the Xcode project for CI builds.

Commit and push the configuration, shared scheme, and documentation to the branch connected to Codemagic:

```sh
git add codemagic.yaml ios-native/ios/App/App.xcodeproj/xcshareddata/xcschemes/App.xcscheme README.md docs/ios.md
git commit -m "Add Codemagic iOS workflows"
git push
```

In Codemagic, select that branch and click **Check for configuration file**. Keep the working directory at the repository root. Both workflows install the two locked npm dependency sets, run the shared checks and tests, build `dist/`, sync Capacitor's generated assets and configuration, verify the native metadata, and resolve Swift packages. Generated web assets and native configuration don't need to be committed.

Choose a workflow when starting a build:

| Workflow | Output | Signing requirements |
| --- | --- | --- |
| `ios-simulator` | Simulator `App.app` and build log | None; use this for the first build. The app runs in a Mac's iOS Simulator. |
| `ios-release` | Signed IPA, debug symbols, and build logs | Apple Distribution certificate and App Store provisioning profile for `com.swsoftworks.pathos` |

For `ios-release`, open **Team settings → codemagic.yaml settings → Code signing identities** in Codemagic. Upload or generate an Apple Distribution certificate with its private key, and upload or fetch a matching App Store provisioning profile. Codemagic's [iOS signing guide](https://docs.codemagic.io/yaml-code-signing/signing-ios/) covers these steps. The workflow selects these signing files by bundle ID and distribution type; it doesn't need credentials in the repository.

Download the IPA from the build's artifacts. The release workflow prepares an App Store/TestFlight IPA but doesn't upload it automatically. For installation on registered test devices instead, change `distribution_type` to `ad_hoc` and provide a matching Ad Hoc profile that includes those devices. A simulator app can't be installed on an iPhone.

Release builds set `CURRENT_PROJECT_VERSION` to the Codemagic workflow's `BUILD_NUMBER + 1`. If you've already uploaded a higher build number elsewhere, adjust that value before uploading another release. Builds run manually; this configuration doesn't enable automatic builds on every push.

## Import and export

Importing works the same way as on the website. The Import button opens the iOS file picker, so you can choose APK and ZIP files from the Files app. Nothing is installed as an Android app.

Exporting opens the native share sheet. Choose **Save to Files** to keep a backup outside the app. If you cancel the sheet, the export is reported as cancelled and your library is unchanged. The native export accepts UTF-8 JSON text up to 256 MiB, so a very large full-library backup may hit that limit or run out of device memory. Exports of individual saves are much smaller.

The web layer calls:

```js
await window.VaultNative.exportFile({
  name: 'pathos-backup.json',
  data: JSON.stringify(backup),
  mime: 'application/json'
});
```

A completed share resolves to `{shared: true, cancelled: false}`, and a cancelled one resolves to `{shared: false, cancelled: true}`. Errors reject the promise. The files written for sharing are temporary and are deleted when the sheet closes.

## Updates and persistence

Keep these values the same in every release:

| Setting | Value |
| --- | --- |
| Bundle ID | `com.swsoftworks.pathos` |
| WKWebView scheme | `capacitor` |
| WKWebView hostname | `localhost` |
| Shared database name | `story-vault` |

The app's local origin is `capacitor://localhost`. Changing the scheme or hostname changes the web storage origin, and the existing IndexedDB library becomes unreachable. Changing the bundle ID installs a separate app. The database name predates the PathOS name and stays as it is so that existing libraries keep working. When you release a new build, increase the version and build numbers but leave these identifiers alone.

Game updates are imported inside the app and have nothing to do with native app releases. The library tracks games, installed versions, and saves as separate records. See [save compatibility](save-compatibility.md).

Deleting the app deletes its local data. The browser and the iOS app have separate storage, so use a backup file to move a library between them. This release doesn't include cloud sync.

## Native boundaries

`VaultBridgeViewController.swift` injects `VaultNative` into the trusted main frame only. The export handler, Capacitor's general native message transport, and the native dialog transport all check `WKScriptMessage.frameInfo.isMainFrame` and the exact bundled origin before forwarding a request. Apple documents the frame property under [WKFrameInfo.isMainFrame](https://developer.apple.com/documentation/webkit/wkframeinfo/ismainframe).

Imported games run in the shared player's sandboxed iframe and never get access to native plugins. The release configuration loads the bundled web assets. It doesn't set a remote `server.url` or an open navigation allowlist.

## Verification status

The project was generated with the pinned Capacitor CLI. Its configuration, storyboard and scene wiring, and injected JavaScript bridge were checked in the development environment. The export JavaScript was run against simulated native replies covering success, cancellation, native errors, invalid input, and the origin and frame restrictions.

Swift compilation, simulator runs, real file picking, native export, and data persistence across signed app upgrades all need Xcode on macOS, and none of them have been tested on an iPhone yet. Before relying on the app for a long playthrough, check these on your device:

- Web Crypto availability and package import
- Local Blob asset loading
- Scene changes and save editing
- Backgrounding and relaunching
- Importing an APK update
- Exporting and re-importing a backup
- Updating the app binary
