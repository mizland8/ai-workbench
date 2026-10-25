# Workbench connections

Implemented in Android Companion 0.2.0 and desktop Workbench 0.2.15.

Each desktop exposes an explicitly enabled TLS service. The phone and other Workbench desktops use the same paired-PC API. Pairing codes include the server certificate, address, port, and a single-use 256-bit challenge valid for five minutes. Each client receives an independently revocable bearer credential; the host stores only its SHA-256 hash. Android pins the exact server certificate and encrypts client credentials using Android Keystore. Desktop remote credentials and host identity are kept in the app-data directory, with owner-only file modes on Unix and the user-profile directory on Windows. The PC listener is off after a restart until explicitly enabled again.

Authenticated snapshots contain project/chat IDs and names, actual available usage data, terminal output for open chats, agent states, and message receipts. Long-poll requests wait for changes; there is no AI-agent status polling. Messages have durable client request IDs and cannot be resubmitted under the same ID with different text. The host persists its queue before acknowledging acceptance, opens closed AI chats, and submits only when the chat is idle and has no approval, menu, or user draft. An uncertain terminal submission is never automatically replayed.

A queued or delivered receipt is not a claim that the AI completed the task. Desktop-to-desktop access is for explicit user interaction; pairing does not grant every AI automatic cross-PC delegation.

Use a local or private network and keep Workbench open. Public relay hosting, Android background notifications, automatic connection at desktop startup, IPv6 literals, and attaching to independently opened terminals are not part of this version.
