import type { BoxDefinition } from "../../../src/server/service.ts"

export function messagesBox(grantsBoxId: string): BoxDefinition {
  const authorize = (action: string, callback: string) => `
    if (typeof input.owner !== "string") throw "A signed-in owner is required";
    return ctx.invoke(
      "${grantsBoxId}",
      "check",
      { owner: input.owner, grantee: ctx.account, permission: "manage messages" }
    ).then(${callback}, ${action});
  `

  return {
    methods: {
      connect: authorize(
        `{ owner: input.owner, clientId: ctx.clientId }`,
        `function connected(granted, request) {
          if (granted !== true) throw "Message permission was not granted";
          if (request.clientId) ctx.storage.private.set("client|" + request.owner, request.clientId);
          return true;
        }`,
      ),
      load: authorize(
        `{ owner: input.owner }`,
        `function loaded(granted, request) {
          if (granted !== true) throw "Message permission was not granted";
          let peers = ctx.storage.private.get("chats|" + request.owner) || [];
          let chats = [];
          for (let index = 0; index < peers.length; index++) {
            let peer = peers[Number(index)];
            chats.push({ peer: peer, messages: ctx.storage.private.get("history|" + request.owner + "|" + peer) || [] });
          }
          return chats;
        }`,
      ),
      send: `
        if (typeof input.owner !== "string" || typeof input.recipient !== "string" || typeof input.text !== "string" || typeof input.messageId !== "string") {
          throw "An owner, recipient, text, and message ID are required";
        }
        if (input.text.length < 1 || input.text.length > 4000) throw "Messages must contain 1 to 4000 characters";
        return ctx.invoke(
          "${grantsBoxId}",
          "check",
          { owner: input.owner, grantee: ctx.account, permission: "manage messages" }
        ).then(function authorized(granted, request) {
          if (granted !== true) throw "Message permission was not granted";
          function addChat(owner, peer) {
            let chats = ctx.storage.private.get("chats|" + owner) || [];
            let found = false;
            for (let index = 0; index < chats.length; index++) {
              if (chats[Number(index)] === peer) found = true;
            }
            if (!found) {
              chats.push(peer);
              ctx.storage.private.set("chats|" + owner, chats);
            }
          }
          function append(owner, peer, message) {
            let key = "history|" + owner + "|" + peer;
            let history = ctx.storage.private.get(key) || [];
            history.push(message);
            if (history.length > 200) history.shift();
            ctx.storage.private.set(key, history);
          }
          let sequence = (ctx.storage.private.get("sequence") || 0) + 1;
          ctx.storage.private.set("sequence", sequence);
          let message = { id: request.messageId, sender: request.owner, recipient: request.recipient, text: request.text, sequence: sequence };
          addChat(request.owner, request.recipient);
          addChat(request.recipient, request.owner);
          append(request.owner, request.recipient, message);
          append(request.recipient, request.owner, message);
          let recipientClient = ctx.storage.private.get("client|" + request.recipient);
          if (recipientClient) ctx.message(recipientClient, { type: "chat.message", message: message });
          return message;
        }, { owner: input.owner, recipient: input.recipient, text: input.text, messageId: input.messageId });
      `,
    },
  }
}
