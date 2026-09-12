# Offline store transfer internals

The SQL handoff in `src/store-transfer-coordinator.ts` is an internal component, not yet an operator command. It runs outside the editable application. It does not acquire process ownership, provision schemas, copy data, or start extensions.

The caller must hold exclusive ownership of the same data volume and all four store connections throughout the operation and their closure. An assertion callback checks that held scope; observing an idle server once is insufficient. No enclosing SQL transaction is allowed. Each durable write commits on its own store before the next store changes.

The target's `settings.transfer_journal` binds a transfer UUID, canonical source and target store pairs without credentials, the volume, the app UUID mirrored in boot, and a reviewed logical manifest digest. Target `transfer_state` stays `in_progress` through copying and verification. The coordinator then retires source boot, retires source app, and finally marks target SQL complete. This follows the corrected build-plan ordering; the older database design's target-complete-before-source-retirement order is unsafe.

A matching durable retirement marker can bridge a failed journal advance. Conflicting markers, mismatched identities, malformed journals, pending recovery operations and unverified copies refuse. A completed replay checks identities and retirement evidence without comparing an old data manifest against legitimate later writes.

Copy adapters must preflight every source table before mutation, preserve the target control rows (`transfer_state`, `transfer_journal`, `transferred_to`), explicitly rebind selected-store adoption metadata, and preserve any historical transfer records without turning them into current authority. Partial data copies must be verified or refused, never blindly appended. The logical manifest accounts explicitly for those transformations and allocator state.

SQL completion is not activation. The outer immutable launcher must prove all connection/process closure and durably publish its filesystem completion receipt before normal boot may open the target. Remaining integration includes that launcher and startup gate, protocol downgrade refusal, actual schema/copy/verification adapters, backup preparation, and cross-engine crash acceptance. The focused coordinator fixtures exercise SQL transaction gaps; they are not whole-process transfer acceptance.
