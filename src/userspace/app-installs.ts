import { procHash } from "../hash.ts";

export const APP_INSTALL_CAPABILITY = "apps:install";

/** Private per-account app lists and public unique installation counts. */
export const APP_INSTALLS_REDUCER_CODE = `function owner() {
  let authorization = ctx.authorization;
  if (authorization == null) throw "Authorization required";
  let allowed = false;
  for (let i = 0; i < authorization.capabilities.length; i += 1) {
    if (authorization.capabilities[Number(i)] == "${APP_INSTALL_CAPABILITY}") allowed = true;
  }
  if (!allowed) throw "Missing apps:install capability";
  return authorization.account;
}
function appId(value) {
  if (typeof value != "string" || value.length != 16) throw "Invalid app ID";
  for (let i = 0; i < value.length; i += 1) {
    let character = value[Number(i)];
    if (!(character >= "a" && character <= "z") && !(character >= "2" && character <= "7")) throw "Invalid app ID";
  }
  return value;
}
if (input.action == "install") {
  let account = owner();
  let id = appId(input.appId);
  let key = "installed:" + account;
  let installed = await ctx.state.private.get(key) || [];
  for (let i = 0; i < installed.length; i += 1) {
    if (installed[Number(i)] == id) return { appId: id, installs: await ctx.state.public.get("installs:" + id) || 0, installed: installed };
  }
  installed[Number(installed.length)] = id;
  ctx.state.private.set(key, installed);
  let count = (await ctx.state.public.get("installs:" + id) || 0) + 1;
  ctx.state.public.set("installs:" + id, count);
  return { appId: id, installs: count, installed: installed };
}
if (input.action == "uninstall") {
  let account = owner();
  let id = appId(input.appId);
  let key = "installed:" + account;
  let installed = await ctx.state.private.get(key) || [];
  let next = [];
  let found = false;
  for (let i = 0; i < installed.length; i += 1) {
    let item = installed[Number(i)];
    if (item == id) found = true;
    else next[Number(next.length)] = item;
  }
  let count = await ctx.state.public.get("installs:" + id) || 0;
  if (!found) return { appId: id, installs: count, installed: installed };
  if (next.length == 0) ctx.state.private.delete(key);
  else ctx.state.private.set(key, next);
  count -= 1;
  if (count <= 0) {
    count = 0;
    ctx.state.public.delete("installs:" + id);
  } else ctx.state.public.set("installs:" + id, count);
  return { appId: id, installs: count, installed: next };
}
if (input.action == "installed") {
  let account = owner();
  return await ctx.state.private.get("installed:" + account) || [];
}
throw "Unknown installs action";`;

export const APP_INSTALLS_REDUCER_HASH = procHash(APP_INSTALLS_REDUCER_CODE);
