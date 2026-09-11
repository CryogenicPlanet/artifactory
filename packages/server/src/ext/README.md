# ext

Optional one-file extensions loaded from each immutable snapshot. `standup.ts` is the runnable read-only example. Read `../kernel/extension-api.ts` for the small Api and `../kernel/ext.ts` for its lifecycle boundary, and `../../pages/docs/extensions.md` for authoring instructions. No factory resources or module-level mutable state. Cron and event hooks run only in live scopes; package discovery and durable webhook delivery remain pending.
