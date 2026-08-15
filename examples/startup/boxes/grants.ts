import type { BoxDefinition } from "../../../src/server/service.ts"

export const grantsBox: BoxDefinition = {
  methods: {
    grant: `
      if (typeof input.grantee !== "string" || typeof input.permission !== "string") {
        throw "A grantee and permission are required";
      }
      let key = ctx.account + "|" + input.grantee + "|" + input.permission;
      ctx.storage.public.set(key, true);
      return { owner: ctx.account, grantee: input.grantee, permission: input.permission };
    `,
    revoke: `
      if (typeof input.grantee !== "string" || typeof input.permission !== "string") {
        throw "A grantee and permission are required";
      }
      let key = ctx.account + "|" + input.grantee + "|" + input.permission;
      ctx.storage.public.delete(key);
      return true;
    `,
    check: `
      if (typeof input.owner !== "string" || typeof input.grantee !== "string" || typeof input.permission !== "string") {
        return false;
      }
      let key = input.owner + "|" + input.grantee + "|" + input.permission;
      return ctx.storage.public.get(key) === true;
    `,
  },
}
