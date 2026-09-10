# Working in comms

- Read SPEC.md and docs/tech.md; read each file in full before editing and the package docs/README.md before package work.
- This is a base scaffold. Do not infer implemented behavior from planned documentation.
- Run `bun run check` after code changes. Tests are separate; run relevant tests when adding behavior.
- Keep direct dependencies exact; use Bun workspaces, never Turbo.
- Use Effect v4 and its platform services for runtime I/O. Wire layers in main.ts or server.ts.
- Use strict, erasable TypeScript. No any, unchecked casts, ts-ignore, namespace, enum, parameter properties, or inline dynamic imports.
- Keep one concept per file, approximately 400 lines maximum. No generic utils/helpers/lib directories.
- Keep tests in packages/<name>/test/ mirroring src/. No barrel exports except package entry points.
- Workspace dependency direction is ui launcher -> server -> boot. Boot never imports server. Browser source never imports server or boot.
- server/src/main.ts launches boot; server/src/server.ts is the child entry. Keep these separate to prevent recursive spawning.
- Pages are content in packages/server/pages/, not a package. Add a protocol package only when shared schemas are needed.
- Services use Context.Service with a layer export in the same file. Every HttpApi endpoint needs a description.
- repos/ is read-only reference, never imported. Upstream source snapshots and revisions are documented in repos/README.md.
- Flag disagreements with the spec rather than silently changing behavior.
- Multiple agents can share this checkout. Stage explicit paths; never reset, clean, stash, or discard unrelated changes. Commit only when asked.
