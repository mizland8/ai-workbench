#!/usr/bin/env bash
set -euo pipefail
project_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
cd "$project_dir/network"
mobile_version=$(go list -m -f '{{.Version}}' golang.org/x/mobile)
go install "golang.org/x/mobile/cmd/gomobile@$mobile_version" "golang.org/x/mobile/cmd/gobind@$mobile_version"
export PATH="$(go env GOPATH)/bin:$PATH"
export GOFLAGS=-buildvcs=false
if [[ -n ${ANDROID_HOME:-} && -d "$ANDROID_HOME/ndk/28.2.13676358" ]]; then
  export ANDROID_NDK_HOME="$ANDROID_HOME/ndk/28.2.13676358"
fi
mkdir -p "$project_dir/mobile/app/libs"
gomobile init
gomobile bind -target=android/arm64,android/amd64 -androidapi=30 -ldflags='-s -w' -o "$project_dir/mobile/app/libs/workbench-network.aar" ./netcore

mkdir -p "$project_dir/mobile/app/src/main/assets"
cp "$project_dir/network/netcore/notices.txt" "$project_dir/mobile/app/src/main/assets/network-notices.txt"
