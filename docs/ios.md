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

## Build on GitHub Actions

The [`Build iOS app`](../.github/workflows/ios.yml) workflow uses GitHub's standard `macos-26` runner with Xcode 26+ and Node.js 22. It installs the locked dependencies, runs the shared checks and tests, builds the web assets, syncs Capacitor, verifies the native project, and resolves Swift packages before compiling. These builds don't need a Codemagic account.

Push the workflow and `scripts/ci/` helpers to the GitHub repository's default branch. Open **Actions → Build iOS app → Run workflow**, select a branch, and choose a build type:

| Build type | Artifact | Requirements |
| --- | --- | --- |
| `unsigned-ipa` (default) | `PathOS-unsigned.ipa` | No signing secrets; sign it with your sideloading tool before installing on an iPhone or iPad |
| `simulator` | `PathOS-simulator.zip`, containing `App.app` | No signing secrets; runs in the iOS Simulator on an Apple silicon Mac |
| `signed-ipa` | `PathOS-signed.ipa` | Apple Distribution certificate with its private key and a matching distribution profile |

Download the build from the completed run's **Artifacts** section. GitHub wraps each artifact in a ZIP, so extract it to get the IPA or simulator ZIP. Simulator builds use the Mac runner's ARM64 architecture and can't be installed on a phone. An unsigned IPA also needs signing before it can be installed. Logs are uploaded separately, including when Xcode fails.

For `signed-ipa`, add these repository secrets under **Settings → Secrets and variables → Actions**:

| Secret | Value |
| --- | --- |
| `IOS_CERTIFICATE_BASE64` | Base64 of an Apple Distribution `.p12` export containing the certificate and private key |
| `IOS_CERTIFICATE_PASSWORD` | The `.p12` password; leave unset if the file has no password |
| `IOS_PROVISIONING_PROFILE_BASE64` | Base64 of the matching `.mobileprovision` file for `com.swsoftworks.pathos` |

On a Mac, encode each file using `base64 -i distribution.p12 | pbcopy` or `base64 -i PathOS.mobileprovision | pbcopy`, then paste the result into its secret. On PowerShell, use `[Convert]::ToBase64String([IO.File]::ReadAllBytes('distribution.p12')) | Set-Clipboard` with the appropriate filename. Keep the certificate, profile, and password out of the repository. GitHub's [Apple signing guide](https://docs.github.com/en/actions/how-tos/deploy/deploy-to-third-party-platforms/sign-xcode-applications) explains the certificate export and secret setup.

The **Distribution method for signed-ipa only** dropdown accepts:

- `app-store-connect`: use an App Store distribution profile; produces an IPA for upload to App Store Connect or TestFlight.
- `release-testing`: use an Ad Hoc distribution profile containing the devices that will install the IPA.

The signed build validates the profile, configures signing only on the `App` target, archives it, and exports the IPA with Xcode. It imports the certificate into a temporary keychain and removes the signing files when the job finishes. Uploading to App Store Connect is a separate step.

Device builds set `CURRENT_PROJECT_VERSION` to `github.run_number`. If another build system has already uploaded a higher number, adjust `build_number` in [`scripts/ci/build-ios.sh`](../scripts/ci/build-ios.sh) before uploading. Workflows run manually and artifacts expire after seven days. GitHub's standard runners are free for public repositories; private repositories use the account's included minutes and storage, with macOS consuming more than Linux. See [GitHub Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions).

For automatically published unsigned builds on GitHub, see [nightly releases](deployment.md#nightly-releases-on-github). The nightly pipeline calls the same iOS build workflow with `unsigned-ipa` and publishes the result to the rolling `nightly` prerelease after both the iOS and web builds succeed.

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

Exporting opens the native share sheet. Choose **Save to Files** to keep a backup outside the app. If you cancel the sheet, the export is reported as cancelled and your library is unchanged. Backups and individual saves use compressed ZIP files. The native bridge accepts base64-encoded binary data and writes the decoded ZIP, with a limit of 256 MiB of decoded file data. A very large library may still hit that limit or run out of device memory.

The web layer calls:

```js
await window.VaultNative.exportFile({
  name: 'pathos-backup.zip',
  data: bytesToBase64(compressedBackup),
  mime: 'application/zip',
  encoding: 'base64'
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

The app's local origin is `capacitor://localhost`. Keep the scheme and hostname stable so that the one-time migration can still find an earlier IndexedDB library. Changing the bundle ID installs a separate app. The database name predates the PathOS name and stays as it is so that existing libraries keep working. When you release a new build, increase the version and build numbers but leave these identifiers alone.

Game updates are imported inside the app and have nothing to do with native app releases. The library tracks games, installed versions, and saves as separate records. See [save compatibility](save-compatibility.md).

The app stores game, version, save and profile records in `Library/Application Support/PathOS/library.sqlite` using SQLite WAL transactions with full synchronization. Binary game files live in immutable UUID directories under `Library/Application Support/PathOS/Assets`. Writes finish and synchronize the new files before committing the referencing records. Rollbacks remove new files, committed deletions retire old files, and startup removes orphaned directories left by interrupted writes. Autosave ownership checks query version keys without reading game files. Imported game paths never become filesystem paths.

On the first upgraded launch, the app reads and validates the complete earlier `story-vault` library, then copies it into native storage in one transaction. A completion marker commits in that same transaction. Migration leaves the old IndexedDB copy intact; it is never used again once migration completes, so deleted native records cannot return from the old copy. Migration failures stop startup with a recovery message, preserve the source, and can be retried. Native storage errors never silently fall back to browser storage.

The library is eligible for normal device backups (including iCloud Backup if enabled for the app). This is not live iCloud sync and does not guarantee the user has a current device backup. Export a full backup to Files or iCloud Drive for an independent, portable copy. Native background saves request limited iOS background execution time while flushing.

Deleting the app deletes its local data. The browser and the iOS app have separate storage, so use a backup file to move a library between them. This release doesn't include cloud sync.

## Native boundaries

`VaultBridgeViewController.swift` injects `VaultNative` into the trusted main frame only. The storage handler, export handler, Capacitor's general native message transport, and the native dialog transport all check `WKScriptMessage.frameInfo.isMainFrame` and the exact bundled origin before forwarding a request. Apple documents the frame property under [WKFrameInfo.isMainFrame](https://developer.apple.com/documentation/webkit/wkframeinfo/ismainframe).

Imported games run in the shared player's sandboxed iframe and never get access to native plugins. The release configuration loads the bundled web assets. It doesn't set a remote `server.url` or an open navigation allowlist.

## Verification status

The project was generated with the pinned Capacitor CLI. Its configuration, storyboard and scene wiring, and injected JavaScript bridge were checked in the development environment. The injected JavaScript is checked against simulated export and storage replies, including errors and the origin and frame restrictions. Shared tests cover native migration, interrupted writes, save retention, conflict rollback, binary backup portability and the iOS storage guidance. On macOS, `npm run verify` additionally compiles `VaultStore.swift` with `scripts/storage-tests.swift` and runs real SQLite/filesystem checks for reopen, binary assets, rollback, migration markers, interrupted imports, orphan cleanup, key-only queries and deletion. The existing macOS build workflows already call that verification command.

Swift compilation, simulator runs, real file picking, native export, and data persistence across signed app upgrades all need Xcode on macOS, and none of them have been tested on an iPhone yet. The native SQLite integration runner has not been executed in the Windows development environment. Before relying on the app for a long playthrough, check these on your device:

- Upgrade a build containing games and saves in IndexedDB; verify the migrated library after force-quitting and reopening.
- Interrupt an initial migration and retry it; verify no partial library or missing source data.
- Save while backgrounding, then reopen offline and verify the latest saved position.
- Restore the same backup twice and verify that saves and game assets remain intact.
- Web Crypto availability and package import
- Local Blob asset loading
- Scene changes and save editing
- Backgrounding and relaunching
- Importing an APK update
- Exporting and re-importing a backup
- Updating the app binary
