# @comms/boot

Bootloader library imported by server. Owns the child process lifetime and propagates failures; no standalone application command.

Read first: `src/index.ts`, `package.json`, and the root README.

Never import server or UI implementation. The launcher passes a child entry path. Proxying, authentication, snapshots, reloads, and recovery remain phase 0 work.
