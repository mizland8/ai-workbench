# Validation — 2026-10-25

The initial preview passed native navigation, computer editing, local draft creation/deletion, and persistence across app restarts on an Android 15 emulator. Version 0.2.0 additionally passed the isolated transport test on the user's physical Pixel: exact TLS certificate pinning, single-use pairing, Android Keystore credential roundtrip, project snapshots, message receipt, and invalid-token rejection. Test traffic used a temporary localhost-only fixture over USB, not real AI sessions.

PC-to-PC pairing uses the same authenticated service. Native macOS and Windows builds and tests run in GitHub CI. Background phone push notifications and operation while a PC sleeps are not implemented.


Version 0.3.0: verified the Android runtime on the physical Pixel after replacing blocked netlink interface enumeration and setting SDK log/temp paths inside app-private storage. The on-device native test confirms startup without a system VPN and availability of interactive sign-in. Desktop helper tests cover private API authentication, browser-origin rejection, and interactive enrollment availability. Actual cross-network use requires signing both devices into the same account and pairing them.
