# Extensions

The extension contract and loader are not implemented yet. See SPEC.md §7.3 and docs/tech.md §2 in the source repository.

Future extensions contribute Effect HttpApi groups at generation startup. Background resources start only when a generation becomes live and stop on draining. Rehearsals and candidates suppress outbound work.

Runnable examples will live in `packages/server/examples/extensions/` once the contract exists.
