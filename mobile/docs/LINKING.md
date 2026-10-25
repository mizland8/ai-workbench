# Workbench connections

LAN transport was introduced in Android Companion 0.2.0 / desktop Workbench 0.2.15. Companion 0.3.0 / Workbench 0.2.16 additionally embed app-scoped Tailscale networking.

Each desktop exposes an explicitly enabled TLS service. The phone and other Workbench desktops use the same paired-PC API. Pairing codes include the server certificate, address, port, and a single-use 256-bit challenge valid for five minutes. Each client receives an independently revocable bearer credential; the host stores only its SHA-256 hash. Android pins the exact server certificate and encrypts client credentials using Android Keystore. Desktop remote credentials and host identity are kept in the app-data directory, with owner-only file modes on Unix and the user-profile directory on Windows. An opted-in remote connection restores its node and selected listener when Workbench starts. LAN-only operation remains off at startup unless that saved remote preference restores it.

Authenticated snapshots contain project/chat IDs and names, actual available usage data, terminal output for open chats, agent states, and message receipts. Long-poll requests wait for changes; there is no AI-agent status polling. Messages have durable client request IDs and cannot be resubmitted under the same ID with different text. The host persists its queue before acknowledging acceptance, opens closed AI chats, and submits only when the chat is idle and has no approval, menu, or user draft. An uncertain terminal submission is never automatically replayed.

A queued or delivered receipt is not a claim that the AI completed the task. Desktop-to-desktop access is for explicit user interaction; pairing does not grant every AI automatic cross-PC delegation.

Use a local or private network and keep Workbench open. The embedded network uses Tailscale’s coordination and relay infrastructure under the user’s account. Background Android notifications, custom coordinator UI, IPv6 literal pairing addresses, and attaching independently opened terminals are not part of this version.
