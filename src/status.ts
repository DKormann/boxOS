import { procHash } from "./hash.ts";
import { IDENTITY_REDUCER_HASH } from "./identity.ts";

export const STATUS_REDUCER_CODE = `if (input.action == "set") {
  if (typeof input.account != "string" || typeof input.name != "string" || typeof input.status != "string" || typeof input.nonce != "string") throw "Invalid status";
  if (input.name.length < 1 || input.name.length > 80 || input.status.length > 280 || input.nonce.length > 200) throw "Invalid status";
  let nonceKey = "nonce:" + input.account + ":" + input.nonce;
  if (ctx.state.private.has(nonceKey)) throw "Authorization already used";
  ctx.state.private.set(nonceKey, true);
  let sequence = (ctx.state.private.get("sequence") || 0) + 1;
  ctx.state.private.set("sequence", sequence);
  let entry = { account: input.account, name: input.name, status: input.status, sequence: sequence };
  let statusKey = "status:" + input.account;
  let previous = ctx.state.public.get(statusKey);
  if (previous != null && previous.name != input.name) {
    let oldKey = "name:" + previous.name;
    let oldItems = ctx.state.public.get(oldKey) || [];
    let kept = [];
    for (let i = 0; i < oldItems.length; i += 1) {
      let item = oldItems[Number(i)];
      if (item.account != input.account) kept[Number(kept.length)] = item;
    }
    ctx.state.public.set(oldKey, kept);
  }
  ctx.state.public.set(statusKey, entry);
  let nameKey = "name:" + input.name;
  let named = ctx.state.public.get(nameKey) || [];
  let nextNamed = [entry];
  for (let i = 0; i < named.length; i += 1) {
    let item = named[Number(i)];
    if (item.account != input.account) nextNamed[Number(nextNamed.length)] = item;
  }
  ctx.state.public.set(nameKey, nextNamed);
  let recent = ctx.state.public.get("recent") || [];
  let nextRecent = [entry];
  for (let i = 0; i < recent.length && nextRecent.length < 10; i += 1) {
    let item = recent[Number(i)];
    if (item.account != input.account) nextRecent[Number(nextRecent.length)] = item;
  }
  ctx.state.public.set("recent", nextRecent);
  return entry;
}
if (input.action == "lookup") return ctx.state.public.get("name:" + input.name) || [];
if (input.action == "recent") return ctx.state.public.get("recent") || [];
throw "Unknown status action";`;

export const STATUS_REDUCER_HASH = procHash(STATUS_REDUCER_CODE);

export const STATUS_PROCEDURE_CODE = `if (input.action == "set") {
  if (typeof input.authorization != "object" || typeof input.authorization.message != "string" || typeof input.authorization.signature != "string") throw "Invalid authorization";
  let grant = JSON.parse(input.authorization.message);
  if (grant.version != 1 || grant.domain != "boxos-capability" || grant.resource != "${STATUS_REDUCER_HASH}" || typeof grant.account != "string" || typeof grant.name != "string" || typeof grant.text != "string" || typeof grant.nonce != "string") throw "Invalid authorization";
  let allowed = false;
  for (let i = 0; i < grant.capabilities.length; i += 1) if (grant.capabilities[Number(i)] == "set status") allowed = true;
  if (!allowed) throw "Missing set status capability";
  function identity(tx) { return tx.invoke("${IDENTITY_REDUCER_HASH}", { action: "lookup", account: grant.account }); }
  let publicKey = await ctx.transaction(identity);
  if (typeof publicKey != "string") throw "Unknown account";
  let valid = await ctx.verify(publicKey, input.authorization.message, input.authorization.signature);
  if (!valid) throw "Invalid signature";
  function update(tx) { return tx.invoke("${STATUS_REDUCER_HASH}", { action: "set", account: grant.account, name: grant.name, status: grant.text, nonce: grant.nonce }); }
  return await ctx.transaction(update);
}
if (input.action == "lookup") {
  function lookup(tx) { return tx.invoke("${STATUS_REDUCER_HASH}", input); }
  return await ctx.transaction(lookup);
}
if (input.action == "recent") {
  function recent(tx) { return tx.invoke("${STATUS_REDUCER_HASH}", input); }
  return await ctx.transaction(recent);
}
throw "Unknown status action";`;

export const STATUS_PROCEDURE_HASH = procHash(STATUS_PROCEDURE_CODE);
