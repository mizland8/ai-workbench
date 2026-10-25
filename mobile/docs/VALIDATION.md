# Validation — 2026-10-25

The initial preview passed native navigation, computer editing, local draft creation/deletion, and persistence across app restarts on an Android 15 emulator. Version 0.2.0 additionally passed the isolated transport test on the user's physical Pixel: exact TLS certificate pinning, single-use pairing, Android Keystore credential roundtrip, project snapshots, message receipt, and invalid-token rejection. Test traffic used a temporary localhost-only fixture over USB, not real AI sessions.

PC-to-PC pairing uses the same authenticated service. Native macOS and Windows builds and tests run in GitHub CI. Background phone push notifications and operation while a PC sleeps are not implemented.
