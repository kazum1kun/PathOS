#!/usr/bin/env bash
set -euo pipefail

build_type="${1:-unsigned-ipa}"
project="${XCODE_PROJECT:-ios-native/ios/App/App.xcodeproj}"
scheme="${XCODE_SCHEME:-App}"
build_number="${GITHUB_RUN_NUMBER:-1}"

case "$build_type" in
  simulator|unsigned-ipa|signed-ipa) ;;
  *) echo "Unknown iOS build type: $build_type" >&2; exit 1 ;;
esac

mkdir -p build/artifacts build/logs

if [[ "$build_type" == simulator ]]; then
  xcodebuild build \
    -project "$project" -scheme "$scheme" \
    -configuration Debug -sdk iphonesimulator \
    -destination 'generic/platform=iOS Simulator' \
    -derivedDataPath build/ios/simulator \
    CODE_SIGNING_ALLOWED=NO \
    2>&1 | tee build/logs/ios-simulator.log
  ditto -c -k --keepParent \
    build/ios/simulator/Build/Products/Debug-iphonesimulator/App.app \
    build/artifacts/PathOS-simulator.zip
  exit 0
fi

signing_allowed=NO
if [[ "$build_type" == signed-ipa ]]; then
  signing_allowed=YES
  test -f build/ios/export-options.plist
fi

xcodebuild archive \
  -project "$project" -scheme "$scheme" \
  -configuration Release -sdk iphoneos \
  -destination 'generic/platform=iOS' \
  -archivePath build/ios/PathOS.xcarchive \
  CURRENT_PROJECT_VERSION="$build_number" \
  CODE_SIGNING_ALLOWED="$signing_allowed" \
  2>&1 | tee build/logs/ios-archive.log

if [[ "$build_type" == unsigned-ipa ]]; then
  mkdir -p build/ios/unsigned/Payload
  ditto build/ios/PathOS.xcarchive/Products/Applications/App.app \
    build/ios/unsigned/Payload/App.app
  ditto -c -k --keepParent build/ios/unsigned/Payload \
    build/artifacts/PathOS-unsigned.ipa
else
  xcodebuild -exportArchive \
    -archivePath build/ios/PathOS.xcarchive \
    -exportPath build/ios/export \
    -exportOptionsPlist build/ios/export-options.plist \
    2>&1 | tee build/logs/ios-export.log
  exported_ipas=(build/ios/export/*.ipa)
  if [[ "${#exported_ipas[@]}" -ne 1 || ! -f "${exported_ipas[0]}" ]]; then
    echo 'Expected one exported IPA.' >&2
    exit 1
  fi
  cp "${exported_ipas[0]}" build/artifacts/PathOS-signed.ipa
fi
