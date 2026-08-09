import { procHash } from "../hash.ts";

export const IDENTITY_REDUCER_CODE = `if (input.action == "register") {
  if (typeof input.publicKey != "string") throw "Expected a public key";
  let account = ctx.sha256(input.publicKey);
  let existing = ctx.state.public.get(account);
  if (typeof existing == "string" && existing != input.publicKey) throw "Account collision";
  ctx.state.public.set(account, input.publicKey);
  return account;
}
if (input.action == "lookup") return ctx.state.public.get(input.account);
throw "Unknown identity action";`;

export const IDENTITY_REDUCER_HASH = procHash(IDENTITY_REDUCER_CODE);

export const IDENTITY_PROCEDURE_CODE = `if (input.action == "register") {
  function register(tx) { return tx.invoke("${IDENTITY_REDUCER_HASH}", input); }
  return await ctx.transaction(register);
}
if (input.action == "verify") {
  function lookup(tx) { return tx.invoke("${IDENTITY_REDUCER_HASH}", { action: "lookup", account: input.account }); }
  let publicKey = await ctx.transaction(lookup);
  if (typeof publicKey != "string") throw "Unknown account";
  let valid = await ctx.verify(publicKey, input.message, input.signature);
  return { account: input.account, valid: valid };
}
throw "Unknown identity action";`;

export const IDENTITY_PROCEDURE_HASH = procHash(IDENTITY_PROCEDURE_CODE);
