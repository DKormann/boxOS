import { procHash } from "./hash.ts";

export const APP_PUBLISH_CAPABILITY = "apps:publish";

/** An append-only public directory of immutable BOXOS pages. */
export const APP_PUBLISHER_REDUCER_CODE = `function author() {
  let authorization = ctx.authorization;
  if (authorization == null) throw "Authorization required";
  let allowed = false;
  for (let i = 0; i < authorization.capabilities.length; i += 1) {
    if (authorization.capabilities[Number(i)] == "${APP_PUBLISH_CAPABILITY}") allowed = true;
  }
  if (!allowed) throw "Missing apps:publish capability";
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
if (input.action == "publish") {
  let publisher = author();
  let id = appId(input.appId);
  let page = appId(input.pageId);
  if (typeof input.name != "string" || input.name.length < 1 || input.name.length > 80) throw "Invalid app name";
  let key = "app:" + id;
  if (ctx.state.public.has(key)) throw "App already published";
  let record = { appId: id, name: input.name, authorId: publisher };
  let sequence = (ctx.state.public.get("publish:counter") || 0) + 1;
  ctx.state.public.set(key, record);
  ctx.state.public.set("publish:" + sequence, id);
  ctx.state.public.set("publish:counter", sequence);
  ctx.state.public.set("release:" + id + ":1", page);
  ctx.state.public.set("release-counter:" + id, 1);
  return record;
}
if (input.action == "unpublish" || input.action == "republish") {
  let publisher = author();
  let id = appId(input.appId);
  let record = ctx.state.public.get("app:" + id);
  if (record == null) throw "Unknown app";
  if (record.authorId != publisher) throw "Only the author can change publication";
  let key = "unpublished:" + id;
  if (input.action == "unpublish") ctx.state.public.set(key, true);
  else ctx.state.public.delete(key);
  return { appId: id, unpublished: input.action == "unpublish" };
}
if (input.action == "release") {
  let publisher = author();
  let id = appId(input.appId);
  let page = appId(input.pageId);
  let record = ctx.state.public.get("app:" + id);
  if (record == null) throw "Unknown app";
  if (record.authorId != publisher) throw "Only the author can publish a release";
  let counterKey = "release-counter:" + id;
  let release = ctx.state.public.get(counterKey) || 1;
  if (ctx.state.public.get("release:" + id + ":" + release) == page) throw "Page is already the current release";
  release += 1;
  ctx.state.public.set("release:" + id + ":" + release, page);
  ctx.state.public.set(counterKey, release);
  return { appId: id, pageId: page, release: release };
}
throw "Unknown publisher action";`;

export const APP_PUBLISHER_REDUCER_HASH = procHash(APP_PUBLISHER_REDUCER_CODE);
