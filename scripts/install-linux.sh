#!/usr/bin/env bash
# Build AI Workbench from this checkout and install it for the current user, without root:
# the app in ~/.local/bin, a launcher entry, and icons. Run it again after making changes.
#   scripts/install-linux.sh              build and install (or update)
#   scripts/install-linux.sh --uninstall  remove what it installed
set -euo pipefail

name=ai-workbench
bin_dir="${XDG_BIN_HOME:-$HOME/.local/bin}"
data_dir="${XDG_DATA_HOME:-$HOME/.local/share}"
desktop_file="$data_dir/applications/$name.desktop"
icon_sizes=(32 64 128 256 512)

refresh_caches() {
  command -v update-desktop-database >/dev/null && update-desktop-database -q "$data_dir/applications" || true
  command -v gtk-update-icon-cache >/dev/null && gtk-update-icon-cache -q -t "$data_dir/icons/hicolor" || true
}

if [[ ${1:-} == --uninstall ]]; then
  rm -f "$bin_dir/$name" "$desktop_file"
  for size in "${icon_sizes[@]}"; do rm -f "$data_dir/icons/hicolor/${size}x${size}/apps/$name.png"; done
  refresh_caches
  echo "Removed AI Workbench. Your workspace and the AI tools' histories were left in place."
  exit 0
fi

cd "$(dirname "$0")/.."
[[ -d node_modules ]] || npm install
npm run tauri build -- --no-bundle

install -Dm755 "src-tauri/target/release/$name" "$bin_dir/$name"
icons=src-tauri/icons
install -Dm644 "$icons/32x32.png" "$data_dir/icons/hicolor/32x32/apps/$name.png"
install -Dm644 "$icons/64x64.png" "$data_dir/icons/hicolor/64x64/apps/$name.png"
install -Dm644 "$icons/128x128.png" "$data_dir/icons/hicolor/128x128/apps/$name.png"
install -Dm644 "$icons/128x128@2x.png" "$data_dir/icons/hicolor/256x256/apps/$name.png"
install -Dm644 "$icons/icon.png" "$data_dir/icons/hicolor/512x512/apps/$name.png"

mkdir -p "$(dirname "$desktop_file")"
cat > "$desktop_file" <<DESKTOP
[Desktop Entry]
Type=Application
Name=AI Workbench
Comment=Run AI coding agents side by side in your project folders
Exec="$bin_dir/$name"
Icon=$name
Terminal=false
Categories=Development;
StartupWMClass=$name
StartupNotify=true
DESKTOP
refresh_caches

echo "Installed AI Workbench: $bin_dir/$name"
echo "It's in your app launcher. After making changes, run this script again to update it."
