if (!input || !input.grant || input.grant.domain != "boxos-grant/0.3.0" || input.grant.permission != "social" || input.grant.subject != ctx.rootCaller || input.grant.account != input.account) throw "Invalid social grant";
let valid = await ctx.verify(input.account, input.grant, input.signature);
if (!valid) throw "Invalid social grant signature";
return ctx.atomic(function graph(tx) {
  let key = input.action == "follow" || input.action == "unfollow" ? "following:" + input.account : input.action == "block" || input.action == "unblock" ? "blocked:" + input.account : "muted:" + input.account;
  let state = input.action == "follow" || input.action == "unfollow" ? tx.state.public : tx.state.private;
  let values = state.get(key) || [];
  if (input.action == "view") return { following: tx.state.public.get("following:" + input.account) || [], blocked: tx.state.private.get("blocked:" + input.account) || [], muted: tx.state.private.get("muted:" + input.account) || [] };
  if (typeof input.target != "string" || input.target == input.account) throw "Invalid account";
  let add = input.action == "follow" || input.action == "block" || input.action == "mute";
  let validAction = add || input.action == "unfollow" || input.action == "unblock" || input.action == "unmute";
  if (!validAction) throw "Unknown social action";
  let next = []; let found = false; let i = 0;
  while (i < values.length) { let value = values[Number(i)]; if (value == input.target) found = true; if (add || value != input.target) next.push(value); i = i + 1; }
  if (add && !found) next.push(input.target);
  state.set(key, next);
  return { following: tx.state.public.get("following:" + input.account) || [], blocked: tx.state.private.get("blocked:" + input.account) || [], muted: tx.state.private.get("muted:" + input.account) || [] };
});
