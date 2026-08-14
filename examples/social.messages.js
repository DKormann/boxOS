if (!input || !input.grant || input.grant.domain != "boxos-grant/0.3.0" || input.grant.permission != "messaging" || input.grant.subject != ctx.rootCaller || input.grant.account != input.account) throw "Invalid messaging grant";
let valid = await ctx.verify(input.account, input.grant, input.signature);
if (!valid) throw "Invalid messaging grant signature";
return ctx.atomic(function messages(tx) {
  let listKey = "conversations:" + input.account;
  let conversations = tx.state.private.get(listKey) || [];
  if (input.action == "send") {
    if (typeof input.target != "string" || input.target == input.account || typeof input.text != "string" || input.text.length < 1 || input.text.length > 2000 || typeof input.sentAt != "number") throw "Invalid message";
    let left = input.account < input.target ? input.account : input.target;
    let right = input.account < input.target ? input.target : input.account;
    let threadKey = "conversation:" + left + ":" + right;
    let thread = tx.state.private.get(threadKey) || [];
    if (thread.length >= 500) throw "Conversation limit reached";
    thread.push({ id: input.id, from: input.account, text: input.text, sentAt: input.sentAt }); tx.state.private.set(threadKey, thread);
    let next = []; let i = 0;
    while (i < conversations.length) { if (conversations[Number(i)] != input.target) next.push(conversations[Number(i)]); i = i + 1; }
    next.push(input.target); conversations = next; tx.state.private.set(listKey, conversations);
    let otherKey = "conversations:" + input.target; let other = tx.state.private.get(otherKey) || []; next = []; i = 0;
    while (i < other.length) { if (other[Number(i)] != input.account) next.push(other[Number(i)]); i = i + 1; }
    next.push(input.account); tx.state.private.set(otherKey, next);
  } else if (input.action != "view") throw "Unknown messaging action";
  let result = []; let i = 0;
  while (i < conversations.length) { let other = conversations[Number(i)]; let left = input.account < other ? input.account : other; let right = input.account < other ? other : input.account; result.push({ account: other, messages: tx.state.private.get("conversation:" + left + ":" + right) || [] }); i = i + 1; }
  return result;
});
