import { procHash } from "./hash.ts";

export const VALIDATE_PROCEDURE_CODE = `return ctx.validate(input.kind, input.code);`;
export const VALIDATE_PROCEDURE_HASH = procHash(VALIDATE_PROCEDURE_CODE);

export const PUBLISH_PROCEDURE_CODE = `return await ctx.publish(input.kind, input.code);`;
export const PUBLISH_PROCEDURE_HASH = procHash(PUBLISH_PROCEDURE_CODE);
