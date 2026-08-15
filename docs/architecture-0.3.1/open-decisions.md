# Open decisions

The core model is settled enough to guide a replacement implementation. The following details remain intentionally open.

## Provider pricing

Define how a provider publishes or agrees to execution charges. The server will enforce only authenticated settlement and available balance, not truthful metering. Possible simple policies include fixed per-method price, provider-declared charge capped by allocated fuel, or server pricing for server-hosted boxes.

## Remote turn settlement

Specify the signed assignment and settlement envelopes, duplicate prevention, and what the server does with a delivery that was assigned but never settled. Runtime 0.3.1 has no automatic retry or general expiry; indefinite waiting is currently valid.

## Root completion

Without public result handles, define how browser and CLI root callers request a durable callback destination. A result with no callback may be discarded after a live transport closes.

## Callback API

Settle exact option names, callback parameter order, validation errors, success and failure envelopes, and whether one unified callback receiving `{ status, value, error }` is simpler than separate callbacks.

## Callback fuel failure

A child returns unused fuel before the parent callback. Specify the exact outcome when the parent still lacks enough fuel to begin that callback, including whether later external funding may cause it to run.

## Funding commands

Specify signed account-to-account and account-to-invocation transfers, strict nonce behavior across devices, closed-invocation handling, and ledger receipt retention.

## Provider and box addresses

Specify encoding of provider-qualified box addresses, provider registration, local box identity, and whether server-hosted boxes use an explicit server provider key.

## State model

Confirm private/public/shared namespaces for 0.3.1 and specify shared-read grants under provider-qualified state. Private state cannot be private from its responsible provider.

## Runtime grammar

Complete the restricted grammar, source limits, deterministic helper library, error values, synchronous callback-source validation, and fuel charging rules.

## HTTP and timers

Specify request schemas, body limits, redirects, timeouts, DNS policy, response encoding, clock authority, and timer ordering. These are provider assertions unless the server itself is the provider.

## Operational loss

Define prototype behavior after server or provider crashes. The architecture forbids automatic re-execution as correctness checking and specifies no retry. It still needs deterministic ledger handling for records left in an in-progress state.
