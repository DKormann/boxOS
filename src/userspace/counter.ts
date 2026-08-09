import { procHash } from "../hash.ts";

export const COUNTER_REDUCER_CODE = `let count = ctx.state.public.get("count") || 0; count += 1; ctx.state.public.set("count", count); return count;`;

export const COUNTER_REDUCER_HASH = procHash(COUNTER_REDUCER_CODE);
