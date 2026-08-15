import type { BoxDefinition } from "../../../src/server/service.ts"

/** Public profile names. Authorization remains in the grants box. */
export function profilesBox(grantsBoxId: string): BoxDefinition {
  return {
    methods: {
      setName: `
        if (typeof input.account !== "string" || typeof input.name !== "string" || typeof input.requestId !== "string") {
          throw "An account, name, and request ID are required";
        }
        let name = input.name;
        if (name.length < 1 || name.length > 64) throw "Profile names must contain 1 to 64 characters";
        ctx.invoke(
          "${grantsBoxId}",
          "check",
          { owner: input.account, grantee: ctx.account, permission: "manage account" },
          function checked(granted, request) {
            let statusKey = "status|" + request.requestId;
            if (granted !== true) {
              ctx.storage.public.set(statusKey, { ok: false, error: "Manage account permission was not granted" });
              return null;
            }
            ctx.storage.public.set("name|" + request.account, request.name);
            ctx.storage.public.set(statusKey, { ok: true, name: request.name });
            return null;
          },
          { account: input.account, name: name, requestId: input.requestId }
        );
        return { pending: true, requestId: input.requestId };
      `,
      get: `
        if (typeof input.account !== "string") return null;
        return ctx.storage.public.get("name|" + input.account);
      `,
    },
  }
}
