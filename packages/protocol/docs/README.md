# @comms/protocol

Pure HTTP declarations and wire schemas shared by the editable server and browser. Read `src/api.ts`, `src/messages.ts` and `src/errors.ts` first. No server implementation, platform I/O or runtime state belongs here.

The runtime seed copies this entire package under `app/protocol`; it is versioned and snapshotted together with the server and UI. Boot does not import it. Server request middleware still owns body limits and authorization.
