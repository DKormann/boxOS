# BOXOS signed accounts

## Model

Signed accounts are application identities, separate from BOXOS fuel accounts. A fuel account pays for an invocation through its bearer credential. A signed account proves control of an Ed25519 private key and can be interpreted by applications however they choose.

The private key stays in the account page's IndexedDB. BOXOS stores only the raw public key in a public identity reducer. The account ID is the SHA-256 hash of the Base64URL public-key string.

The account manager is an ordinary immutable example page:

```text
/examples/accounts
```

Its origin is the key vault. The page should remain immutable because publishing changed source creates a new origin with separate IndexedDB storage.

## Capability grants

An application asks for arbitrary text capabilities such as:

```text
read messages
write messages
```

The account manager signs a canonical JSON grant:

```json
{
  "version": 1,
  "domain": "boxos-capability",
  "account": "<account-id>",
  "name": "<local account name>",
  "audience": "<requesting-origin>",
  "resource": "<target reducer or application ID>",
  "capabilities": ["read messages", "write messages"],
  "text": "optional arbitrary text",
  "nonce": "<one-time random value>"
}
```

Capabilities have no global semantics. The receiving application decides what each string means. It must check the audience, required capabilities, and nonce in addition to verifying the signature.

Capabilities are sorted and duplicate values are removed before signing. The grant uses recursively key-sorted canonical JSON. The signature covers that exact UTF-8 message.

## Popup authorization

A page can request authorization through the browser client:

```js
const authorization = await boxos.authorize(
  ["read messages", "write messages"],
  "Access the shared inbox",
  targetReducerHash,
);
```

The client opens `/examples/accounts` in a popup. The account page displays the requesting browser origin, capabilities, text, and a simple account-name chooser. After the user selects an account and approves, the popup returns the signed grant with `postMessage` to that exact origin. It never returns a private key.

The request contains a random nonce and request ID. The account manager ignores any claimed audience and uses the browser-provided `event.origin` as the signed audience.

## Verification

The client can invoke the built-in identity procedure:

```js
const receipt = await boxos.verifyAuthorization(authorization);
if (!receipt.ok.valid) throw new Error("Invalid signature");
```

Applications must then enforce policy themselves:

```js
const grant = authorization.grant;
if (grant.audience !== location.origin) throw new Error("Wrong audience");
if (grant.resource !== targetReducerHash) throw new Error("Wrong resource");
if (!grant.capabilities.includes("write messages")) throw new Error("Not allowed");
```

A signature proves that the account signed the text. It does not prove that a nonce is fresh. An application that accepts a grant more than once must use its own reducer to record or issue nonces and reject replay.

## Identity functions

`GET /stats` returns:

```json
{
  "identities": {
    "reducer": "<identity-reducer-hash>",
    "procedure": "<identity-procedure-hash>"
  }
}
```

The identity procedure accepts:

```json
{"action":"register","publicKey":"<Base64URL Ed25519 public key>"}
```

and:

```json
{
  "action":"verify",
  "account":"<account-id>",
  "message":"<exact canonical text>",
  "signature":"<Base64URL Ed25519 signature>"
}
```

Procedures may also call the trusted asynchronous capability directly:

```js
return await ctx.verify(publicKey, message, signature);
```

The capability accepts a 32-byte Ed25519 public key, arbitrary UTF-8 text, and a 64-byte signature, all binary values encoded as unpadded Base64URL where applicable.

## Status example

`/examples/status` demonstrates the complete flow. It requests the `set status` capability with the status text as the signed arbitrary text and binds the grant to the status reducer. Its procedure verifies the signature and capability before updating state. The reducer rejects reused nonces, stores each account's latest status, indexes account names, and exposes the ten most recent updates.

## Security boundaries

- Never send a private key to an application page or procedure.
- Treat the account-manager page origin as a permanent key vault.
- Verification does not assign meaning to capability strings.
- Audience checks prevent grants from being moved between applications.
- Application reducers remain responsible for replay protection.
- Signed accounts do not currently replace `ctx.caller` or pay fuel.
