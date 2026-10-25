# Workbench Companion for Android

Native Android companion for AI Workbench. Version 0.4.1 restores a visible Usage shortcut with allowances grouped by computer, and uses **Computers → Projects → Chats → Conversation**, preserves context with breadcrumbs, handles system Back within the app, and keeps the composer fixed below terminal output. Desktop Workbench 0.2.19 is recommended; replies to approval/menu prompts require 0.2.18 or later. LAN pairing remains compatible with 0.2.15.

## Built-in remote access

On each PC, open Computers, enable built-in remote access, choose a device name, and sign into your personal Tailscale account. On the phone, open Computers → Remote connection settings, enable the connection and sign into the same account. No separate VPN app is required. Create a remote pairing code on the PC and paste the whole code into Link computer or Update pairing code on the phone. Pairing remains necessary even when both devices are signed into the same account.

The desktop restores opted-in remote access when Workbench starts. Keep it open and the PC awake. The phone's embedded networking runs in the app process. Keys stay in the app's private files, and Workbench pairing credentials remain encrypted with Android Keystore. No root access is required; Android interface enumeration uses the app-compatible native implementation instead of netlink.

## Connect a PC over the LAN

1. On the PC, open Workbench → Computers → Enable linking. The default TLS port is 47931.
2. Enter that PC's local IPv4 address or private-network hostname and choose Create pairing code.
3. On the phone, open Computers, edit the PC's name, choose Link computer, and paste the complete code.
4. Repeat for the other PCs. Keep Workbench open and the PCs awake.

Use the same Wi-Fi or a private network such as Tailscale. OS firewalls may need an incoming TCP allowance for the selected port. Pairing codes are single-use and expire after five minutes. The phone pins the exact PC certificate and encrypts its credentials with Android Keystore. Revoke a phone independently from the PC's Computers menu. Opted-in built-in remote access reconnects when Workbench starts; LAN-only linking is not independently auto-started.

## Features

- Three initial computer entries; add, rename, annotate, pair, unlink, and remove PCs.
- Project/chat browsing, terminal output, current agent states, and available allowance data.
- Explicit remote message sending with durable request IDs and queued/delivered receipts.
- Busy chats, approvals, menus, and unsent user drafts hold remote work until the chat can accept it.
- Local drafts are never sent automatically. Computer entries, drafts, and pending send retry IDs survive restarts.
- Connections run while the companion is in the foreground. No background push notifications yet.

A delivery receipt means the prompt was submitted, not that the AI completed its work. A `delivery_unknown` receipt must be inspected on the PC; it is never replayed automatically.

## Build

Requires JDK 17, Android SDK platform 35, build tools 35.0.0, and the checked-in Gradle 8.11.1 wrapper. Android Gradle Plugin is 8.9.2.

First build the native networking dependency from the repository root with `bash scripts/build-android-network.sh`. This requires Go 1.27.3 and Android NDK 28.2.13676358, and produces the ignored AAR and notice asset. Then set `JAVA_HOME` and `ANDROID_HOME`, or add an ignored `local.properties` containing `sdk.dir=/absolute/path/to/sdk`.

```
./gradlew assembleDebug lintDebug
```

For the signed preview release, set `AIW_ANDROID_KEYSTORE` to the existing preview keystore, then run `./gradlew assembleRelease lintRelease`. Keep the keystore private and backed up; replacing it prevents updates over an installed copy. The preview uses the development key alias/password with a unique private key. Release builds disable debugging. Play Store distribution needs a separate signing/distribution plan.

## USB installation

Enable Developer options and USB debugging on the phone, connect a data-capable cable, and accept the computer authorization prompt. Update without uninstalling to preserve data:

```
adb install -r app/build/outputs/apk/release/app-release.apk
adb shell am start -n com.aiworkbench.companion/.MainActivity
```

## Tests

`scripts/smoke-emulator.py` checks native navigation and local draft persistence on a clean emulator. The opt-in `TransportTestRunner` instrumentation test connects to the desktop Rust `android_transport_fixture` through `adb reverse`, verifying TLS pinning, one-time pairing, encrypted credential storage, snapshots, receipts, and invalid credential rejection. It does not send work to a real AI or read user projects.
