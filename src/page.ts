import { procHash } from "./hash.ts";

export const PAGE_MAX_BYTES = 256 * 1024;

export const PAGE_REDUCER_CODE = `if (typeof input != "string") throw "Expected a string";
let hash = ctx.pageHash(input);
let existing = ctx.state.public.get(hash);
if (typeof existing == "string" && existing != input) throw "Page hash collision";
ctx.state.public.set(hash, input);
return hash;`;

export const PAGE_REDUCER_HASH = procHash(PAGE_REDUCER_CODE);
