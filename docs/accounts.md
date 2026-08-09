# BOXOS signed accounts and capabilities

## Accounts and profiles

A BOXOS invocation has two independent identities:

- The bearer fuel account pays for runtime and storage and is exposed as `ctx.caller`.
- A browser-owned Ed25519 account grants application capabilities and is exposed as `ctx.authorization`.

The immutable account manager stores only this private browser record:

```js
{ id, publicKey, privateKey }
```

It never stores a name. Creating or restoring an account registers its public key and immediately writes the chosen display name to the canonical profile reducer using a signed `profile:write` grant. Account creation does not complete unless that profile write succeeds.

The account chooser reads current names from public profile state. Applications do the same, so the profile reducer is the only source of display names.

## Granting an application access

An application asks for a narrow capability on one reducer:

```js
const authorization = await boxos.authorize(
  ["todo:manage"],
  "View and change your private todos",
  todoReducerHash,
);
```

The account manager shows the immutable requesting origin, purpose, resource, and capabilities. After approval it returns a canonical signed version 2 grant:

```json
{
  "version": 2,
  "domain": "boxos-capability",
  "account": "<account-id>",
  "audience": "https://<page-id>.pages.boxos.org",
  "resource": "<reducer-hash>",
  "capabilities": ["todo:manage"],
  "purpose": "View and change your private todos",
  "grantId": "<random grant-id>"
}
```

The authorization envelope also carries the public key, exact canonical message, and signature. It carries no profile information.

A grant is a durable delegated capability, not a signature over one operation. An application can keep it in its isolated `localStorage` and reuse it until the user signs out.

## Invoking with a capability

Authorization is invocation metadata, not reducer input:

```js
await boxos.invoke(todoReducerHash, { action: "add", id, text }, {
  authorization,
});
```

Before any application code runs, BOXOS:

1. reconstructs the canonical grant;
2. derives the account ID from the supplied public key;
3. verifies the Ed25519 signature;
4. checks the requesting browser origin against `audience`; and
5. makes the verified grant available only to the reducer named by `resource`.

The reducer checks the capability and derives ownership from trusted context. It never accepts an account ID from input for an authenticated write. Direct reducer calls and newly published procedures cannot fabricate `ctx.authorization`.

Procedures receive the same verified authorization and pass it implicitly into transactions. Only a reducer whose hash equals the grant resource sees it.

## Canonical profile reducer

`GET /stats` exposes one built-in profile reducer under `profiles.reducer`. It stores one public document per account:

```json
{
  "account": "<account-id>",
  "name": "Display name",
  "bio": "Optional biography",
  "revision": 1
}
```

Names are not unique. `set` and `delete` require a grant for the profile reducer containing `profile:write`; ownership always comes from `ctx.authorization.account`. `get` is public, as is direct access to the `profile:<account-id>` public-state key.

`/examples/profile?account=<account-id>` displays a linkable public profile. The same page lets an account owner edit or delete their profile.

## Startup pages

The built-in startup reducer stores one private immutable page ID per signed account. The root `boxos.org` page may request a durable `startup:manage` grant and retain it in root-origin localStorage.

On later visits the root uses that authorization to read the canonical setting and redirect. `/about` always shows the pitch instead. An immutable app can propose itself by navigating to:

```text
https://boxos.org/start?candidate=<its-page-id>
```

The trusted root page validates the page and asks for confirmation before changing the setting. Startup IDs are exact immutable pages and do not follow App Explorer releases.

## Deployment identity

On first startup BOXOS generates a deployment identity and saves its recovery key beside the database as `<database>.system-key` with owner-only permissions. Keep this file secret and persist it with the database. `BOXOS_SYSTEM_KEY_PATH` can select another path, or `BOXOS_SYSTEM_RECOVERY_KEY` can provide a dedicated `boxos1.<private-key>.<public-key>` value directly.

At startup BOXOS registers that identity, creates its canonical `BOXOS` profile, and publishes every repository example under a deterministic app ID. When an example's immutable page changes, startup appends a release owned by the same identity rather than creating another app.

## Security properties and limits

- Grants are bound to one immutable browser origin and one immutable reducer.
- Capability strings are interpreted by the target reducer.
- Account IDs and authorization-shaped JSON in ordinary reducer input carry no authority.
- A copied grant is a bearer capability for its stated audience, resource, and capabilities.
- Grants currently have no expiry or server-side revocation. `grantId` allows a runtime-enforced revocation registry to be added without changing application reducers.
- Signed accounts do not currently pay fuel; the invoking bearer account does.
