import type { BoxDefinition } from "../../../src/server/service.ts"

/** Public app catalog and private per-account installations. */
export function appsBox(grantsBoxId: string): BoxDefinition {
  const authorize = (callback: string, context: string) => `
    return ctx.invoke(
      "${grantsBoxId}",
      "check",
      { owner: input.owner, grantee: ctx.account, permission: "manage apps" }
    ).then(${callback}, ${context});
  `

  return {
    methods: {
      publish: `
        if (typeof input.owner !== "string" || typeof input.name !== "string" || typeof input.pageId !== "string" || typeof input.requestId !== "string") {
          throw "An owner, name, page ID, and request ID are required";
        }
        if (input.name.length < 1 || input.name.length > 80) throw "App names must contain 1 to 80 characters";
        if (input.pageId.length !== 16) throw "A 16-character page ID is required";
        for (let index = 0; index < input.pageId.length; index++) {
          if (!"abcdef0123456789".includes(input.pageId[Number(index)])) throw "The page ID is invalid";
        }
        ${authorize(`function published(granted, request) {
          if (granted !== true) {
            throw "Manage apps permission was not granted";
          }
          if (ctx.storage.public.get("page|" + request.pageId)) {
            throw "That page is already in the catalog";
          }
          let appId = request.requestId;
          if (ctx.storage.public.get("app|" + appId)) {
            throw "That app ID is already in use";
          }
          let app = { id: appId, owner: request.owner, name: request.name, pageId: request.pageId, version: 1 };
          let catalog = ctx.storage.public.get("catalog") || [];
          catalog.push(appId);
          ctx.storage.public.set("catalog", catalog);
          ctx.storage.public.set("app|" + appId, app);
          ctx.storage.public.set("versions|" + appId, [{ version: 1, pageId: request.pageId }]);
          ctx.storage.public.set("page|" + request.pageId, appId);
          return app;
        }`, `{ owner: input.owner, name: input.name, pageId: input.pageId, requestId: input.requestId }`)}
      `,
      update: `
        if (typeof input.owner !== "string" || typeof input.appId !== "string" || typeof input.name !== "string" || typeof input.pageId !== "string" || typeof input.requestId !== "string") {
          throw "An owner, app ID, name, page ID, and request ID are required";
        }
        if (input.name.length < 1 || input.name.length > 80) throw "App names must contain 1 to 80 characters";
        if (input.pageId.length !== 16) throw "A 16-character page ID is required";
        for (let index = 0; index < input.pageId.length; index++) {
          if (!"abcdef0123456789".includes(input.pageId[Number(index)])) throw "The page ID is invalid";
        }
        ${authorize(`function updated(granted, request) {
          if (granted !== true) {
            throw "Manage apps permission was not granted";
          }
          let current = ctx.storage.public.get("app|" + request.appId);
          if (!current || current.owner !== request.owner) {
            throw "Only the publisher can update this app";
          }
          let existing = ctx.storage.public.get("page|" + request.pageId);
          if (existing && existing !== request.appId) {
            throw "That page belongs to another app";
          }
          let version = current.version;
          if (current.pageId !== request.pageId) {
            version = version + 1;
            let versions = ctx.storage.public.get("versions|" + request.appId) || [];
            versions.push({ version: version, pageId: request.pageId });
            ctx.storage.public.set("versions|" + request.appId, versions);
            ctx.storage.public.set("page|" + request.pageId, request.appId);
          }
          let app = { id: request.appId, owner: request.owner, name: request.name, pageId: request.pageId, version: version };
          ctx.storage.public.set("app|" + request.appId, app);
          return app;
        }`, `{ owner: input.owner, appId: input.appId, name: input.name, pageId: input.pageId, requestId: input.requestId }`)}
      `,
      install: `
        if (typeof input.owner !== "string" || typeof input.appId !== "string" || typeof input.requestId !== "string") {
          throw "An owner, app ID, and request ID are required";
        }
        ${authorize(`function completedInstall(granted, request) {
          if (granted !== true) {
            throw "Manage apps permission was not granted";
          }
          let app = ctx.storage.public.get("app|" + request.appId);
          if (!app) {
            throw "App not found";
          }
          let installed = ctx.storage.private.get("installed|" + request.owner) || [];
          let next = [];
          let found = false;
          for (let index = 0; index < installed.length; index++) {
            let item = installed[Number(index)];
            if (item.appId === request.appId) {
              next.push({ appId: request.appId, version: app.version });
              found = true;
            } else {
              next.push(item);
            }
          }
          if (!found) next.push({ appId: request.appId, version: app.version });
          ctx.storage.private.set("installed|" + request.owner, next);
          return true;
        }`, `{ owner: input.owner, appId: input.appId, requestId: input.requestId }`)}
      `,
      uninstall: `
        if (typeof input.owner !== "string" || typeof input.appId !== "string" || typeof input.requestId !== "string") {
          throw "An owner, app ID, and request ID are required";
        }
        ${authorize(`function uninstalled(granted, request) {
          if (granted !== true) {
            throw "Manage apps permission was not granted";
          }
          let installed = ctx.storage.private.get("installed|" + request.owner) || [];
          let kept = [];
          for (let index = 0; index < installed.length; index++) {
            let item = installed[Number(index)];
            if (item.appId !== request.appId) kept.push(item);
          }
          ctx.storage.private.set("installed|" + request.owner, kept);
          return true;
        }`, `{ owner: input.owner, appId: input.appId, requestId: input.requestId }`)}
      `,
      loadInstalled: `
        if (typeof input.owner !== "string" || typeof input.requestId !== "string") {
          throw "An owner, request ID, and client are required";
        }
        ${authorize(`function loaded(granted, request) {
          if (granted !== true) throw "Manage apps permission was not granted";
          return ctx.storage.private.get("installed|" + request.owner) || [];
        }`, `{ owner: input.owner, requestId: input.requestId }`)}
      `,
    },
  }
}
