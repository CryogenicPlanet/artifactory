import { Schema } from "effect";

/** Reset never accepts source paths or data deletion options from the caller. */
export const SourceResetParams = Schema.Record(Schema.String, Schema.Never);
export const validSeedDigest = (digest: string) => /^[a-f0-9]{64}$/.test(digest);
export const canonicalSourceReset = (seedDigest: string, sessionId: string) =>
	JSON.stringify({ seed: seedDigest, session: sessionId });
