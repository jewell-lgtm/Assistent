#!/bin/sh
# Build the GENERIC APK on the laptop. Nothing user-specific is baked — the
# pairing screen binds a device to its server at first launch. One APK, all users.
set -eu
cd "$(dirname "$0")/.."
export ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"

cd app
npx expo prebuild --platform android --no-install
cd android
# arm64 only + capped workers/heap: full 4-ABI parallel build OOMs the laptop
export GRADLE_OPTS="-Xmx4096m -XX:MaxMetaspaceSize=1024m"
./gradlew assembleRelease -PreactNativeArchitectures=arm64-v8a --max-workers=4
echo "APK: $(pwd)/app/build/outputs/apk/release/app-release.apk"
