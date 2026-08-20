import type { BoxDefinition } from "../../../src/server/service.ts"

/** Public profile names. Authorization remains in the grants box. */
export function profilesBox(grantsBoxId: string): BoxDefinition {
  return {
    methods: {
      setName: `
        if (typeof input.account !== "string" || typeof input.name !== "string") {
          throw "An account and name are required";
        }
        if (input.name.length < 1 || input.name.length > 64) throw "Profile names must contain 1 to 64 characters";
        return ctx.invoke(
          "${grantsBoxId}",
          "check",
          { owner: input.account, grantee: ctx.account, permission: "manage account" }
        ).then(function checked(granted, request) {
          if (granted !== true) throw "Manage account permission was not granted";
          ctx.storage.public.set("name|" + request.account, request.name);
          return { name: request.name };
        }, { account: input.account, name: input.name });
      `,
      get: `
        if (typeof input.account !== "string") return null;
        return ctx.storage.public.get("name|" + input.account);
      `,
    },
  }
}
