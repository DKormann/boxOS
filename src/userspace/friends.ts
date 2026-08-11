import { procHash } from "../hash.ts";

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
let following = await ctx.state.public.get("following:" + owner) || [];
let followers = await ctx.state.public.get("followers:" + owner) || [];
let muted = await ctx.state.private.get("muted:" + owner) || [];
let blocked = await ctx.state.private.get("blocked:" + owner) || [];
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
  return { following: following, followers: followers, muted: muted, blocked: blocked };
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
    following = changed(following, input.target, input.enabled);
    let targetFollowers = await ctx.state.public.get("followers:" + input.target) || [];
    targetFollowers = changed(targetFollowers, owner, input.enabled);
    setPublic("following:" + owner, following);
    setPublic("followers:" + input.target, targetFollowers);
  } else if (input.relation == "mute") {
    muted = changed(muted, input.target, input.enabled);
    setPrivate("muted:" + owner, muted);
  } else if (input.relation == "block") {
    blocked = changed(blocked, input.target, input.enabled);
    setPrivate("blocked:" + owner, blocked);
  } else throw "Invalid relation";
  return lists();
}
throw "Unknown friends action";`;

export const FRIENDS_REDUCER_HASH = procHash(FRIENDS_REDUCER_CODE);
