#!/bin/sh
# Build the base APK on the laptop. Embeds API_TOKEN into OTA request headers
# via app.config.ts, so source secrets first.
set -eu
cd "$(dirname "$0")/.."
. ./.DONOTCOMMIT/secrets.env
export API_TOKEN
export ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"

cd app
npx expo prebuild --platform android --no-install
cd android
./gradlew assembleRelease
echo "APK: $(pwd)/app/build/outputs/apk/release/app-release.apk"
