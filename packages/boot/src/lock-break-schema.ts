import { Schema } from "effect";

export const BreakLock = Schema.Struct({ id: Schema.String });
export type BreakLock = typeof BreakLock.Type;
export const validLockId = (id: string) =>
	/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(id);
export const canonicalLockBreak = (params: BreakLock) => `{"id":"${params.id}"}`;
