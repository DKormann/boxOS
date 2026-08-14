if (!input || !input.grant || input.grant.domain != "boxos-grant/0.3.0" || input.grant.permission != "messaging" || input.grant.subject != ctx.rootCaller || input.grant.account != input.account) throw "Invalid messaging grant";
let valid = await ctx.verify(input.account, input.grant, input.signature);
if (!valid) throw "Invalid messaging grant signature";
return ctx.atomic(function groups(tx) {
  let listKey = "groups:" + input.account;
  let ids = tx.state.private.get(listKey) || [];
  if (input.action == "create") {
    if (typeof input.group != "string" || typeof input.name != "string" || input.name.length < 1 || input.name.length > 80) throw "Invalid group";
    if (tx.state.private.has("group:" + input.group)) throw "Group already exists";
    tx.state.private.set("group:" + input.group, { id: input.group, name: input.name, owner: input.account, members: [input.account], messages: [] }); ids.push(input.group); tx.state.private.set(listKey, ids);
  } else if (input.action == "invite") {
    let group = tx.state.private.get("group:" + input.group);
    if (!group || group.owner != input.account || typeof input.target != "string") throw "Only the owner can invite accounts";
    let found = false; let i = 0; while (i < group.members.length) { if (group.members[Number(i)] == input.target) found = true; i = i + 1; }
    if (!found) { group.members.push(input.target); tx.state.private.set("group:" + input.group, group); let otherKey = "groups:" + input.target; let other = tx.state.private.get(otherKey) || []; other.push(input.group); tx.state.private.set(otherKey, other); }
  } else if (input.action == "send") {
    let group = tx.state.private.get("group:" + input.group);
    if (!group || typeof input.text != "string" || input.text.length < 1 || input.text.length > 2000 || typeof input.sentAt != "number") throw "Invalid group message";
    let member = false; let i = 0; while (i < group.members.length) { if (group.members[Number(i)] == input.account) member = true; i = i + 1; }
    if (!member) throw "You are not a group member";
    group.messages.push({ id: input.id, from: input.account, text: input.text, sentAt: input.sentAt }); tx.state.private.set("group:" + input.group, group);
  } else if (input.action != "view") throw "Unknown group action";
  let result = []; let i = 0; while (i < ids.length) { let group = tx.state.private.get("group:" + ids[Number(i)]); if (group) result.push(group); i = i + 1; }
  return result;
});
