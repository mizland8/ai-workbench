#!/usr/bin/env bash
set -euo pipefail
project_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
if [[ -x "$project_dir/tools/sdk/platform-tools/adb" ]]; then
  adb_bin="$project_dir/tools/sdk/platform-tools/adb"
else
  adb_bin=adb
fi
apk="$project_dir/artifacts/workbench-companion-0.2.0.apk"
[[ -f "$apk" ]] || apk="$project_dir/app/build/outputs/apk/debug/app-debug.apk"
"$adb_bin" devices -l
"$adb_bin" -d install -r "$apk"
"$adb_bin" -d shell am start -n com.aiworkbench.companion/.MainActivity
