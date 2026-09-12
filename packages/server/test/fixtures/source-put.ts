import { sourcePut as bootSourcePut } from "../../../boot/test/fixtures/source-put.ts";

/** Exercise the public source protocol through the shared boot transport fixture. */
export const sourcePut = (input: string, init: RequestInit) => bootSourcePut(input, init);
