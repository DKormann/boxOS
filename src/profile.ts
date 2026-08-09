import { procHash } from "./hash.ts";

export const PROFILE_WRITE_CAPABILITY = "profile:write";

/** One public profile per signed account. Names are not unique. */
export const PROFILE_REDUCER_CODE = `function account() {
  let authorization = ctx.authorization;
  if (authorization == null) throw "Authorization required";
  let allowed = false;
  for (let i = 0; i < authorization.capabilities.length; i += 1) {
    if (authorization.capabilities[Number(i)] == "${PROFILE_WRITE_CAPABILITY}") allowed = true;
  }
  if (!allowed) throw "Missing profile:write capability";
  return authorization.account;
}
if (input.action == "get") {
  if (typeof input.account != "string") throw "Invalid account";
  return ctx.state.public.get("profile:" + input.account);
}
if (input.action == "set") {
  let owner = account();
  if (typeof input.name != "string" || typeof input.bio != "string") throw "Invalid profile";
  if (input.name.length < 1 || input.name.length > 80 || input.bio.length > 500) throw "Invalid profile";
  let key = "profile:" + owner;
  let previous = ctx.state.public.get(key);
  let revision = previous == null ? 1 : previous.revision + 1;
  let profile = { account: owner, name: input.name, bio: input.bio, revision: revision };
  ctx.state.public.set(key, profile);
  return profile;
}
if (input.action == "delete") {
  let owner = account();
  ctx.state.public.delete("profile:" + owner);
  return true;
}
throw "Unknown profile action";`;

export const PROFILE_REDUCER_HASH = procHash(PROFILE_REDUCER_CODE);
