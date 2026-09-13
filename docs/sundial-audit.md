# Audit: Sundial's agent-facing API, and what chirp should take from it

Done by actually following `https://www.sundial.md/start` as an agent on 2026-09-10: joined the workspace, live-synced this folder, wrote `main.tex`, compiled it through their API, pulled the PDF. Everything worked first try. Sync was up in ~25s including a one-time Node download; compile took 5.8s end to end.

## What Sundial gets right

1. **The onboarding page is the skill, served at one URL.** `/start` is `text/markdown` with Agent Skills frontmatter, content-negotiated (browsers get HTML, `curl` gets markdown), with a `/start.md` alias for downloaders that refuse HTML. This is exactly the `/init` design in SPEC.md, now validated by a shipping product.
2. **"Install a pointer, never a snapshot."** The skill stub they tell agents to install is four lines: *fetch /start and follow it*. A downloaded copy goes stale and resurrects corrected instructions. chirp's `/init` said to `curl init > SKILL.md`; that was wrong. Fixed in SPEC §5.
3. **The guide carries a version and every call can stamp it.** `Version f3b459ef6c. Stamp v= onto every call; the response tells you if this copy has gone stale. No routine re-checks.` Cheap detruction of agents running on old instructions. Adopted: `X-Comms-Init` header.
4. **Three tiers of progressive disclosure.** `/start` (orientation), `/.well-known/agent.json` (machine manifest: endpoints, auth, capabilities), `/agent-docs` (full contract: grep, exec, events, errors, optimistic locking). An agent reads only as deep as it needs. Adopted: `/.well-known/agent.json` generated from the live route table.
5. **Harness-aware instructions.** The doc knows how agents actually run: "env vars don't persist between commands in Claude Code, put the token on the same line"; "if your harness can run commands in the background, run the long-poll as a background task and end your turn, the harness wakes you when something lands". That last one is the single best idea in the document and it is the answer to "how does an agent see incoming messages". Adopted in `/init`'s Listen section.
6. **Edit endpoint shaped like the agent's own Edit tool.** `POST /file/edit` takes `{old_string, new_string, replace_all}` and returns `409 ANCHOR_NOT_FOUND` / `409 AMBIGUOUS_ANCHOR`. Zero translation cost for a model that already thinks in those terms. Optimistic locking via `baseUpdatedAt`. Adopted as `POST /api/fs/edit`.
7. **Errors say what to do.** A status → meaning → action table; named codes; `413` carries `useUpload: true`; `503` carries `retriable: true`. chirp already has `hint`; adopted `retriable`.
8. **Long-poll done carefully.** `GET /events` blocks ~55s, streams whitespace heartbeats that keep the body valid JSON, returns a `cursor` to pass as the next `since`, filters out your own actions. Adopted for `wait=`.
9. **Presence is a side effect of any authenticated request.** No separate heartbeat to remember. Adopted: `last_seen_at` on every request, `/api/agents` shows who is around.
10. **Idempotent mutations.** GET-rail mutations require a fresh `k=`; replays return the first outcome, so an agent retrying a flaky call can't double-post. Adopted: `Idempotency-Key` on `POST /api/messages`.
11. **A canonical report-back phrase.** "Reply *Connected in Sundial and ready*." The human learns to recognise success at a glance. Adopted: "Enrolled in chirp as claude@host."
12. **It shapes the agent's behaviour toward the human, not just toward the API.** "Three bullets, one short line each, then a question." "Persistence is the default, but it must never be a secret." "Never infer completeness from a quiet file tree." These are the parts a reference doc usually leaves out.
13. **Teaches the agent to stop.** "After ~3 failed compile rounds post the log tail to the human instead of looping." "Do not loop on errors; surface the raw response and request id."

## What not to copy

- **Too many auth rails.** `sd_anon` cookie, Bearer token, `?token=`, `key=`, `anon=`, `k=`. Each exists for a real reason (browsing-only tools, no-POST tools, ownership handoff), but it is a lot of surface and the GET rail puts credentials in URLs that end up in logs. chirp keeps one bearer + one refresh and lets a GET-only rail be an extension if anyone ever needs it.
- **Dual identifiers.** Workspaces are addressed by UUID but shared by slug, and the doc has to say so twice. chirp addresses everything by name.
- **Implementation-leaky paths.** `/api/workspace/local-agent/...`, `/api/templates/new`. Route names should describe the resource, not the client that first used it.
- **Weight.** 30KB, with a 93-row template catalog inline and a lot of defensive prose ("do not try DNS-over-HTTPS"). Every line is earned from a failure, but it all lands in the agent's context on every fetch. chirp should keep `/init` under ~4KB and push detail to `/api` and `pages/docs/`.
- **Persistent self-updating daemon by default.** Right for a sync product, wrong for chirp, which has nothing to run on the agent's machine.

## Applied to SPEC.md

§5 `/init`: pointer stub instead of a snapshot; version stamp; canonical report-back; Listen section with the background-task pattern; size budget. §6: `/.well-known/agent.json`, `POST /api/fs/edit` with anchors and `baseVersion`, `Idempotency-Key`, `retriable`, presence on any request, `cursor` in long-poll responses.
