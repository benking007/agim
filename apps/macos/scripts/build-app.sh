#!/usr/bin/env bash
# Build a standalone Agim.app (Release) and optionally install into Applications.
#
# Usage:
#   ./scripts/build-app.sh              # build only → dist/Agim.app
#   ./scripts/build-app.sh --install    # build + copy to /Applications (or ~/Applications)
#   ./scripts/build-app.sh --install --user   # force ~/Applications
#
# Requires: macOS + Xcode command-line tools. Set DEVELOPMENT_TEAM in Xcode
# Signing & Capabilities for a signed build that Gatekeeper trusts more easily.
set -euo pipefail
cd "$(dirname "$0")/.."

INSTALL=0
USER_APPS=0
for arg in "$@"; do
  case "$arg" in
    --install) INSTALL=1 ;;
    --user) USER_APPS=1 ;;
    -h|--help)
      sed -n '2,12p' "$0"
      exit 0
      ;;
  esac
done

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "error: this script must run on macOS with Xcode." >&2
  exit 1
fi

if [[ ! -f Agim.xcodeproj/project.pbxproj ]]; then
  ./scripts/generate-xcodeproj.sh
fi

DIST="$(pwd)/dist"
DERIVED="$(pwd)/build/DerivedData"
rm -rf "$DIST" "$DERIVED"
mkdir -p "$DIST"

echo "==> Building Release Agim.app…"
xcodebuild \
  -project Agim.xcodeproj \
  -scheme Agim \
  -configuration Release \
  -derivedDataPath "$DERIVED" \
  -destination 'platform=macOS' \
  CODE_SIGN_IDENTITY="-" \
  CODE_SIGNING_ALLOWED=YES \
  CODE_SIGNING_REQUIRED=NO \
  build

APP_SRC="$DERIVED/Build/Products/Release/Agim.app"
if [[ ! -d "$APP_SRC" ]]; then
  echo "error: build succeeded but Agim.app not found at $APP_SRC" >&2
  exit 1
fi

cp -R "$APP_SRC" "$DIST/Agim.app"
echo "==> Built: $DIST/Agim.app"

if [[ "$INSTALL" -eq 1 ]]; then
  if [[ "$USER_APPS" -eq 1 ]]; then
    DEST_DIR="$HOME/Applications"
  elif [[ -w /Applications ]]; then
    DEST_DIR="/Applications"
  else
    DEST_DIR="$HOME/Applications"
    echo "note: /Applications not writable; installing to $DEST_DIR"
  fi
  mkdir -p "$DEST_DIR"
  DEST="$DEST_DIR/Agim.app"
  rm -rf "$DEST"
  cp -R "$DIST/Agim.app" "$DEST"
  echo "==> Installed: $DEST"
  echo "    Open via Spotlight / Launchpad, or: open \"$DEST\""
  # Clear quarantine so first launch is less noisy for local builds.
  xattr -dr com.apple.quarantine "$DEST" 2>/dev/null || true
else
  echo
  echo "Install manually:"
  echo "  cp -R \"$DIST/Agim.app\" /Applications/"
  echo "or:"
  echo "  ./scripts/build-app.sh --install"
fi
