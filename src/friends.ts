import { procHash } from "./hash.ts";

export const FRIENDS_MANAGE_CAPABILITY = "friends:manage";

/** Independent follow, mute, and block lists owned by each signed account. */
export const FRIENDS_REDUCER_CODE = `let authorization = ctx.authorization;
if (authorization == null) throw "Authorization required";
let allowed = false;
for (let i = 0; i < authorization.capabilities.length; i += 1) {
  if (authorization.capabilities[Number(i)] == "${FRIENDS_MANAGE_CAPABILITY}") allowed = true;
}
if (!allowed) throw "Missing friends:manage capability";
let owner = authorization.account;
function publicList(key) { return ctx.state.public.get(key) || []; }
function privateList(key) { return ctx.state.private.get(key) || []; }
function contains(items, account) {
  for (let i = 0; i < items.length; i += 1) if (items[Number(i)] == account) return true;
  return false;
}
function changed(items, account, enabled) {
  let next = [];
  for (let i = 0; i < items.length; i += 1) {
    let item = items[Number(i)];
    if (item != account) next[Number(next.length)] = item;
  }
  if (enabled && !contains(items, account)) next[Number(next.length)] = account;
  if (next.length > 500) throw "List limit reached";
  return next;
}
function setPublic(key, items) {
  if (items.length == 0) ctx.state.public.delete(key);
  else ctx.state.public.set(key, items);
}
function setPrivate(key, items) {
  if (items.length == 0) ctx.state.private.delete(key);
  else ctx.state.private.set(key, items);
}
function lists() {
  return {
    following: publicList("following:" + owner),
    followers: publicList("followers:" + owner),
    muted: privateList("muted:" + owner),
    blocked: privateList("blocked:" + owner)
  };
}
if (input.action == "list") return lists();
if (input.action == "change") {
  if (typeof input.target != "string" || input.target.length != 64 || input.target == owner) throw "Invalid target";
  if (typeof input.enabled != "boolean") throw "Invalid change";
  for (let i = 0; i < input.target.length; i += 1) {
    let character = input.target[Number(i)];
    if (!(character >= "0" && character <= "9") && !(character >= "a" && character <= "f")) throw "Invalid target";
  }
  if (input.relation == "follow") {
    setPublic("following:" + owner, changed(publicList("following:" + owner), input.target, input.enabled));
    setPublic("followers:" + input.target, changed(publicList("followers:" + input.target), owner, input.enabled));
  } else if (input.relation == "mute") {
    setPrivate("muted:" + owner, changed(privateList("muted:" + owner), input.target, input.enabled));
  } else if (input.relation == "block") {
    setPrivate("blocked:" + owner, changed(privateList("blocked:" + owner), input.target, input.enabled));
  } else throw "Invalid relation";
  return lists();
}
throw "Unknown friends action";`;

export const FRIENDS_REDUCER_HASH = procHash(FRIENDS_REDUCER_CODE);
