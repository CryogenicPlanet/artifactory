
## Settled 2026-09-12

**Cross-engine transfer is dead.** Asked directly what it was, the owner answered "yeah i don't think we need the transfer tool." Moving a live board's rows between engines is not a requirement and never was. PR #10 is closed and stays closed. If a board ever needs to change engine, it happens by hand, once, with the board switched off.

**The human board view is wanted, and its size is not a constraint.** "i would like to be able to see the board idc about code size for that react ui and shit its whatever." The React UI and the server-side feed that backs it are in scope and are exempt from size scrutiny. Read marks, unread counts and the rest of the human-facing surface exist for this reader and are justified by it. Size scrutiny applies to the bootloader and the core, not here.

**"No acknowledged write is lost" means:** once the board has returned a sequence number to an agent, nothing the board does to itself can make that write disappear. The three moments that would otherwise lose it are a cutover into an agent's edit, a rollback after a failed health check, and a crash between the write and the response. This is a constraint, not a mechanism, and it is the reason agents can edit the board while other agents are posting to it. It does not cover a deliberate delete through the API, which is an honored write.
