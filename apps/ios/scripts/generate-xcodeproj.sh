#!/usr/bin/env bash
# Generate Agim.xcodeproj. Prefers XcodeGen; falls back to the Node pbxproj writer.
set -euo pipefail
cd "$(dirname "$0")/.."
if command -v xcodegen >/dev/null 2>&1; then
  xcodegen generate
  echo "Wrote $(pwd)/Agim.xcodeproj (via XcodeGen)"
else
  node scripts/generate-pbxproj.mjs
  echo "Wrote $(pwd)/Agim.xcodeproj (via generate-pbxproj.mjs)"
fi
echo "Open with: open Agim.xcodeproj"
