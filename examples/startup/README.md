# Startup examples

These content-addressed boxes, blobs, and pages are deployed idempotently
whenever the BoxOS server starts. Pages are ordinary `.html` files with IDs
substituted at deployment. Current deployments are recorded in SQLite's
`startup_deployments` table.

`default.css` is the shared BoxOS design language. It provides dark-first,
system-aware palette variables and lightweight card, button, and input classes.
Example pages should link to its deployed blob rather than copy the palette.

## App Explorer

The App Explorer is the startup catalog and launcher. Anyone can browse its
public app records. After signing in through Accounts and granting `manage
apps`, a user can publish a named BoxOS page, install catalog entries into a
private per-account list, and remove them again.

A publisher can point an existing app record at a newly published immutable
page. This increments the app version and retains its public page history.
Installations record the selected version, so the Explorer can offer an update
when a newer page is available without losing the app's identity.

## Accounts page

The Accounts page stores identity private keys as non-extractable `CryptoKey`
objects in origin-scoped IndexedDB. It creates, imports, selects, and grants
access to accounts; it does not edit existing profiles.

Creating an account performs the one-time profile setup:

1. generate an Ed25519 identity in the browser;
2. grant the Accounts page account `manage account` permission;
3. ask the profiles box to set the initial public profile name.

Any app account granted `manage account` can later call `profiles.setName`. The
Accounts page deliberately does not expose that action.

Like every BoxOS page, the Accounts app is served from its immutable page ID.

## Profile page

The Profile page requests `manage account` through the Accounts page, then lets
the granted page account read and update only the public profile name.

Apps request grants by redirecting to `/accounts` with:

- `app_name`: human-readable requesting app name;
- `app_account`: the requesting page account's public key;
- `permissions`: comma-separated permission names;
- `redirect_uri`: HTTP(S) return URL;
- `state`: optional caller state.

After approval, the Accounts page redirects with a fragment containing `account`,
`grants_box`, `profiles_box`, and the original `state`. The grant itself is public
state in the grants box and can be checked through its `check` method. An app
with `manage account` may call `profiles.setName` for that account.

## Social chat page

The Social page requests `manage messages` and the existing `manage account`
profile capability on first visit. Its messages box keeps chat history and
connected client IDs in private storage. Authorized page accounts can load or
send messages for the selected human account, with live delivery over SSE.
