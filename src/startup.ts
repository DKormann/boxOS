import { procHash } from "./hash.ts";

export const STARTUP_MANAGE_CAPABILITY = "startup:manage";

/** One private immutable startup-page ID per signed account. */
export const STARTUP_REDUCER_CODE = `function account() {
  let authorization = ctx.authorization;
  if (authorization == null) throw "Authorization required";
  let allowed = false;
  for (let i = 0; i < authorization.capabilities.length; i += 1) {
    if (authorization.capabilities[Number(i)] == "${STARTUP_MANAGE_CAPABILITY}") allowed = true;
  }
  if (!allowed) throw "Missing startup:manage capability";
  return authorization.account;
}
function pageId(value) {
  if (typeof value != "string" || value.length != 16) throw "Invalid page ID";
  for (let i = 0; i < value.length; i += 1) {
    let character = value[Number(i)];
    if (!(character >= "a" && character <= "z") && !(character >= "2" && character <= "7")) throw "Invalid page ID";
  }
  return value;
}
if (input.action == "get") {
  let value = ctx.state.private.get("startup:" + account());
  return value == null ? null : value;
}
if (input.action == "set") {
  let owner = account();
  let page = pageId(input.pageId);
  ctx.state.private.set("startup:" + owner, page);
  return page;
}
if (input.action == "clear") {
  ctx.state.private.delete("startup:" + account());
  return true;
}
throw "Unknown startup action";`;

export const STARTUP_REDUCER_HASH = procHash(STARTUP_REDUCER_CODE);
