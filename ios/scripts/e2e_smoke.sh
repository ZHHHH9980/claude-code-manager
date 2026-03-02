#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
PROJECT_PATH="$ROOT_DIR/ios/CCMMobileMVP.xcodeproj"
SCHEME="CCMMobileMVP"
DERIVED_DATA="${DERIVED_DATA:-/tmp/ccm-ios-e2e-derived}"
SIM_NAME="${SIM_NAME:-iPhone 17}"
SERVER_URL="${SERVER_URL:-http://43.138.129.193:3000}"
BUNDLE_ID="${BUNDLE_ID:-com.local.CCMMobileMVP}"
RESULT_KEY="ccm_e2e_smoke_result_json"
TIMEOUT_SEC="${TIMEOUT_SEC:-80}"
ACCESS_TOKEN="${ACCESS_TOKEN:-}"

build_destination="platform=iOS Simulator,name=${SIM_NAME}"

boot_device() {
  if ! xcrun simctl list devices available | rg -q "${SIM_NAME} \("; then
    SIM_NAME="iPhone 16"
    build_destination="platform=iOS Simulator,name=${SIM_NAME}"
  fi
  UDID="$(xcrun simctl list devices available | awk -v n="$SIM_NAME" -F '[()]' '$0 ~ n {print $2; exit}')"
  if [[ -z "${UDID:-}" ]]; then
    echo "[ios-e2e] cannot find available simulator"
    exit 1
  fi
  xcrun simctl boot "$UDID" >/dev/null 2>&1 || true
  xcrun simctl bootstatus "$UDID" -b
}

echo "[ios-e2e] building for simulator: $SIM_NAME"
xcodebuild \
  -project "$PROJECT_PATH" \
  -scheme "$SCHEME" \
  -configuration Debug \
  -destination "$build_destination" \
  -derivedDataPath "$DERIVED_DATA" \
  build >/tmp/ccm-ios-e2e-build.log 2>&1

echo "[ios-e2e] build ok"

APP_PATH="$DERIVED_DATA/Build/Products/Debug-iphonesimulator/CCMMobileMVP.app"
if [[ ! -d "$APP_PATH" ]]; then
  echo "[ios-e2e] app not found: $APP_PATH"
  exit 1
fi

boot_device

xcrun simctl install "$UDID" "$APP_PATH" >/dev/null
APP_CONTAINER="$(xcrun simctl get_app_container "$UDID" "$BUNDLE_ID" data)"
PREFS_PLIST="$APP_CONTAINER/Library/Preferences/$BUNDLE_ID.plist"
if [[ -f "$PREFS_PLIST" ]]; then
  /usr/libexec/PlistBuddy -c "Delete $RESULT_KEY" "$PREFS_PLIST" >/dev/null 2>&1 || true
fi

ARGS=("--ccm-e2e-smoke" "--ccm-server-url" "$SERVER_URL")
if [[ -n "$ACCESS_TOKEN" ]]; then
  ARGS+=("--ccm-access-token" "$ACCESS_TOKEN")
fi

echo "[ios-e2e] launching app with smoke args"
xcrun simctl launch "$UDID" "$BUNDLE_ID" "${ARGS[@]}" >/tmp/ccm-ios-e2e-launch.log 2>&1 || {
  echo "[ios-e2e] failed to launch app (bundle id: $BUNDLE_ID)"
  cat /tmp/ccm-ios-e2e-launch.log
  exit 1
}

START_TS="$(date +%s)"
RESULT=""
while true; do
  NOW_TS="$(date +%s)"
  if (( NOW_TS - START_TS > TIMEOUT_SEC )); then
    echo "[ios-e2e] timeout waiting for result key $RESULT_KEY"
    exit 1
  fi

  RESULT="$(
    /usr/libexec/PlistBuddy -c "Print $RESULT_KEY" "$PREFS_PLIST" 2>/dev/null || true
  )"
  if [[ -n "$RESULT" ]]; then
    break
  fi
  sleep 2

done

echo "[ios-e2e] raw result: $RESULT"

python3 - <<'PY' "$RESULT"
import json
import sys
raw = sys.argv[1]
obj = json.loads(raw)
print('[ios-e2e] parsed:', json.dumps(obj, ensure_ascii=False))
if not obj.get('ok'):
    print('[ios-e2e] FAIL:', obj.get('error'))
    raise SystemExit(1)
print('[ios-e2e] PASS')
PY
