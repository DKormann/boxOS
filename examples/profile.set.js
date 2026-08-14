if (!input || typeof input.username != "string" || input.username.length < 1 || input.username.length > 32) {
  throw "Username must contain between 1 and 32 characters";
}
if (!input.grant || input.grant.domain != "boxos-grant/0.3.0" ||
    input.grant.permission != "public-profile" || input.grant.subject != ctx.rootCaller ||
    input.grant.account != input.account) {
  throw "Invalid profile grant";
}
let valid = await ctx.verify(input.account, input.grant, input.signature);
if (!valid) throw "Invalid profile grant signature";
return ctx.atomic(function setProfile(tx) {
  tx.state.public.set(input.account, { username: input.username, publicKey: input.account });
  return { username: input.username, publicKey: input.account };
});
