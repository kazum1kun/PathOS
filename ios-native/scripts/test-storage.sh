#!/usr/bin/env bash
set -euo pipefail
native_root="$(cd "$(dirname "$0")/.." && pwd)"
test_binary="$(mktemp -t pathos-storage-tests)"
trap 'rm -f "$test_binary"' EXIT
xcrun swiftc "$native_root/ios/App/App/VaultStore.swift" \
  "$native_root/scripts/storage-tests.swift" -o "$test_binary"
"$test_binary"
