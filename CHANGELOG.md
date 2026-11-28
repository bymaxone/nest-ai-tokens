# Changelog

All notable changes to `@bymax-one/nest-ai-tokens` will be documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

Versioning is **not** strict [SemVer](https://semver.org/spec/v2.0.0.html) while this API is pre-stable: breaking changes ship in minor and patch releases by explicit `@bymax-one` policy, so a version number carries no compatibility information. The **Apply** note, on the entries that carry one, is the compatibility contract — read it, not the number.

---

## [Unreleased]

## [1.1.26] - 2026-11-27

**Apply:** no database migration and no option change. A host that reverses a compensating record, or appends a record
that does, now gets `AI_TOKENS_IDEMPOTENCY_CONFLICT`. A host that calls `RedisBudgetCounterStore` itself and reads the
`message` or `command` of a rejection should read its `code`.

### Changed

- A command that fails now rejects `RedisBudgetCounterStore` with the store's own error: the message `counter command failed`
  and, when the failure has one, its `code` (`OOM`, `READONLY`). The error of the Redis client, with its
  message, command and arguments, is not passed on. A connection URL that cannot be parsed rejects with `invalid connection URL`.
- Internal: most mutation-testing suppression comments were removed from the source. No change in behaviour is intended.

### Fixed

- `reverse()` refuses a compensating record, one with `reversesRecordId`, and `LedgerService.append()` refuses a record
  whose `reversesRecordId` names one. `reverse()` used to accept it: the ledger, and for an enforced non-system record the budget,
  counted the charge again while the wallet was not debited. Rows already written that way are not repaired; they are the
  compensating records whose `reversesRecordId` points at another compensating record.
- Documentation: the specification said `reverse()` runs in one store transaction. It does not. The specification and the
  README now say what a failure part-way leaves, what a retry completes, and what needs the settlement sweep. No behaviour
  changed.

## [1.1.25] - 2026-11-26

**Apply:** no database migration and no option change. A host with its own `IWalletStore` (`appendEntry` now receives a fourth argument), a `switch` that must cover every `AiTokensEventType`, a consumer of `ai_tokens.hold.released` or a client that retries after a failed settle should read the **Apply** notes below.

### Added

- `ai_tokens.settle.failed` (`{ holdId?, correlationId?, errorCode?, where }`, with the tenant and scope on the envelope) and the
  `SettleFailedEventData` type. It says that a served call was not settled, so the host can reconcile the usage from its own
  provider log; the error's message is never carried. A call with no hold has no `holdId`, and
  `correlationId` is the one of the call's metering context, so set it if you need to match such a call; it is carried when it is text
  of at most 256 characters with no NUL. When the ledger could not be read back after the failure, the row may exist all the same, so
  check the ledger before billing from your provider's log.
  - **Known limit.** The event is a snapshot: the row may post after it, and `LedgerFilter` has no `correlationId`.
  - **Known limit.** The error reaches the caller after the delivery, so a sink that never settles holds the failed request.
  - **Known limit.** A small budget or wallet can refuse further calls until the reaper releases an unsettled hold; `release()` it by
    the event's `holdId`, tenant and scope to free it sooner.
  - **Apply:** `AiTokensEventType` gains a member, so a `switch` that must cover every type needs a case for it.

### Fixed

- `MeteringInterceptor` released the guard's hold as `handler threw` when the handler had succeeded and settling failed. A pending hold
  now stays pending and the hold reaper releases it after TTL, normally within one interval. **Apply:** until then its wallet and budget
  reservation stays in place, and a retry with the same idempotency key gets the same hold. A consumer of the
  `ai_tokens.hold.released` event no longer receives one at the time of the failure.
- `MeteringInterceptor` without a guard's hold now emits `ai_tokens.settle.failed` when the handler returned and `record()` failed
  before writing its row. The thrown error is unchanged.
- `MeteringService.meter()` now emits `ai_tokens.settle.failed` when the function had served and its usage could not be
  settled, after releasing the hold when there is one; the release and the thrown error are unchanged.
- The hold reaper reclaimed at most 100 expired holds per sweep, so a backlog kept its reservations for many sweeps after the TTL. A
  sweep now reads further batches while one comes back full, up to 100 batches.
  - **Known limit.** A hold that keeps failing to be released can be tried again in each of a sweep's batches,
    with a warning each time.
- A grant given no `effectiveAt` was left out of the stored balance, and out of the running balance of its entry, when the application clock was ahead of the database clock: it entered only at the next debit or `reconcile()`. The Prisma store now keeps the earlier of the two clocks for such a grant. A given `effectiveAt`, `new Date()` included, is stored unchanged. Entries already written are not changed.
  - **Known limit.** Such a grant whose `expiresAt` is already past on the application clock, but not yet on the database clock, shows in a plain `getBalance()` until the next debit or `reconcile()`; a debit cannot spend it.

### For store implementors

- `IWalletStore.appendEntry` receives a fourth argument, `{ effectiveAtDefaulted }`. When it is `true`, store the earlier of `entry.effectiveAt` and the instant you stamp `createdAt` with, and judge the balance contribution on the stored value. A store that ignores it behaves as before.
  - **Apply:** `WalletService` now passes four arguments on every `appendEntry` call, the third `undefined`. A store with an optional fourth parameter of its own, such as a transaction handle, no longer type-checks against `IWalletStore` when that type is unrelated to `AppendEntryOptions`, and is handed `{ effectiveAtDefaulted }` in that position at run time: move that parameter.

## [1.1.24] - 2026-11-25

**Apply:** run `0004_wallet_entry_order.sql`, then `0005_wallet_entry_order_indexes.sql`, before you update the package. 0004 only adds columns and 0005 only adds indexes and a foreign key; neither rewrites a row, and each header documents its rollback. Entries written before 0004 keep `seq` and `balanceAfterNanoUsd` null and sort first in the order they always had. During a rolling deploy, an instance still on the previous release writes entries with a null `seq`, so those entries list before the ones the new code wrote; the balance, the running balance of later entries and the refund cap count them correctly.

### Added

- `refund()` accepts `restore: 'source'` and `debitEntryId`: the refund puts the amount back on the grants the debit burned, by negative allocation rows, and links itself to the debit. A part on an expired grant is taken out again by an `expiry:refund:<refundId>:<grantId>` entry. A `hold:` or `record:` debit is refused, and the restorable amount is capped by the debit less its linked refunds and the unlinked refunds and positive adjustments of the same `usageRecordId`. A replay of the key is checked in both directions: a plain refund and a restoring refund never share a key.
- `getBalance(ref, { asOf })` and `getBalanceBreakdown(ref, { asOf })` answer what could be spent at an instant; an `asOf` more than 5 seconds in the past is refused. Both need a store with `balanceAt` and `balanceBreakdown`, which are optional on the port.
- Each ledger entry of a wallet carries a per-wallet `seq` and the `balanceAfterNanoUsd` it left, and entries list in commit order.

### Fixed

- `BudgetGuard` could not be built by Nest in a host that names it in `@UseGuards(BudgetGuard)`, including the README's own controller: its constructor parameters carried no `@Inject`, the published build is made without decorator metadata, and Nest reported "can't resolve dependencies of the BudgetGuard (?, +, +, Symbol(BYMAX_AI_TOKENS_OPTIONS))". It failed in every published version. Every parameter now names its token. A consumer-runtime gate now boots a Nest host over HTTP against the packed tarball with the README controller, and proves the guard passes a request under budget, answers 402 or 429 over it, and refuses a hold larger than the budget before the handler runs.
- `@RequireBudget` with a `{ tokens }` or `{ amountNanoUsd }` estimate on a rate-table mode is refused with `AI_TOKENS_INVALID_CONFIG` (HTTP 500) before the handler runs when `pricing.strict` is true and the price list has no price for the row its hold will record. Such an estimate settles on the model `context.baseModel` names (the placeholder `unspecified` when none, which no rate table lists), so with none or an unlisted one its settle after the provider call was refused with `AI_TOKENS_PRICE_NOT_FOUND` and the served usage was released unbilled; a `baseModel` listed for the preset's provider is placed and billed as before (with no preset the provider is `unspecified`, no `baseModel` is listed for it, and the guard refuses). A provider-reported preset, a rated `{ provider, model, ... }` estimate and `pricing.strict: false` are unchanged; with `strict: false` an unpriced hold on a rate-table mode is recorded at 0 USD, so name provider and model to bill it. A direct `metering.hold()` followed by `capture()` is unchanged.
- The realm guard no longer refuses every billing call in a host that evaluates a second copy of `reflect-metadata` after the package loaded. It recorded every function of `Reflect`, so the functions that polyfill defines again were read as a replaced built-in. It now records only the functions the language defines on `Reflect`; a replaced one is still refused, and no decision of the library reads a polyfill function.

### Documentation

- README step 4 names the model in the `@RequireBudget` estimate and extracts the provider response in `@Meter`: the anthropic normalizer reads the whole response, so the default `result.usage` made the settle fail with `AI_TOKENS_USAGE_MALFORMED`.

### Changed

- `appendEntry` of the Prisma store locks the wallet row before it writes. Parallel writers to one wallet queue on that lock. The cost of the lock, measured on a local PostgreSQL with 8 parallel appends (a relative figure between the two versions, not a capacity): about 1.5 ms at p50 and 2.2 ms at p95 on one wallet (p50 5.1 to 6.6 ms, p95 7.6 to 9.8 ms), and about 0.9 ms at p95 on eight wallets (p95 4.9 to 5.8 ms).

## [1.1.23] - 2026-11-24

**Apply:** no migration and no option change is needed. This release closes one class of defect: a host that planted `Promise[Symbol.species]`, a `then` or a `constructor` could decide what a store or a callback answered, because the library chained the promise it was given. It now waits for what a host returns with a native `await`, after refusing a native promise that carries a `then` or a `constructor` of its own, and refuses it again when the answer it resolved with has a `then`. A store, a markup policy, a tokenizer, an fx function and the async options factory may still return a `Promise` subclass, a thenable (a plain object or a class instance with a `then`, a query builder) or a native promise of another realm, as in 1.1.22. A Proxy is refused, since its traps are host code: a promise that is a Proxy is refused on every call, and for the function `meter()` runs an answer that is a Proxy is refused too, with `AI_TOKENS_INVALID_CONFIG`, so a provider SDK that wraps its response in a Proxy must be unwrapped by the host before the function returns it. The module also loads when the global `Promise` was replaced before the import (a subclass, bluebird, zone.js, a wrapper): it takes the engine's promise from an async function and never reads the global.

### Fixed

- A host can no longer answer for a store through `Promise[Symbol.species]` or a replaced `Promise.resolve`. Decision sites chained a promise a store returned (`.then`, `.catch`, `Promise.all`), and a chain builds its result with the species constructor read live, so a planted species made a store return a forged answer. Decision sites now wait natively, and check the promise they got first: one whose `constructor` or `then` a host planted for the one read is refused instead of answering. A source scan fails on any new chain or promise combinator in shipped code that is not named with the reason its result decides nothing.
- The realm guard reads the `value` of a property descriptor as the descriptor's own, so a `value` planted on `Object.prototype` cannot make an accessor look like a built-in function, and it refuses while `Promise.prototype.constructor` is not `Promise`, while either it or `then` is an accessor, or while the getter of `Promise[Symbol.species]` is not the engine's, which a driver's own `then` reads.
- The Redis counter takes the client from a box with no prototype, so a `then` planted on the class of the client cannot swap the client the store runs its script on.
- The hold reaper waits for a sweep natively, so a species that never settles can no longer leave the running flag set and stop later sweeps.
- A promise a host returns is waited for with a native `await`, after a synchronous check that a native promise has no `then` or `constructor` of its own and that the value is no Proxy; the answer is checked again after the wait. A `Promise` subclass, a thenable and a native promise of another realm are waited for as in 1.1.22, because the `then` they run is the one the host gave them. A value with a `then` anywhere on its chain is refused as an answer, since resolving it would run that `then`. **Apply:** none; a store that returns a native promise, a subclass or a thenable works as before.
- After every store or host answer the `Array.prototype` members the library reads are compared with the engine's, and neither prototype may hold a `then`, and the budget and status lists are built with helpers that read none of them, so a one-shot `map`, `filter`, `push` or `then` a store plants is refused instead of emptying a budget list and letting an over-limit consume through.
- The Redis client is quit on shutdown even when its connection promise was refused, and the bounded quit no longer races a promise.
- These checks are best-effort hardening, not a security boundary against code that already runs in the host process; see "Threat model: same-process code" in `SECURITY.md` for what stays a known limit.

### Documentation

- The README states the limit of a ledger store without the optional effects-owed marker calls. A wallet leg that fails after a capture commits leaves the record posted at its actual cost while the wallet keeps the hold's reserved debit, and a second capture returns the posted record without running the leg again. A store that keeps the marker, as the Prisma store does, lets the reaper finish the leg.

## [1.1.22] - 2026-11-22

**Apply:** no migration and no option change is needed. This release closes one class of defect, found in every earlier release: a key put on `Object.prototype` (by another library, or by prototype pollution) was read as a value the host had supplied, in the options of the module, the metadata of `@Meter` and `@RequireBudget`, the usage a handler returns and a normalizer builds, the rows, filters and optional methods of a store, the inputs the PostgreSQL adapter binds and the descriptors the library defines. Read the **Changed** entries before you upgrade: the library now refuses to start or to move money in a process whose `Object.prototype` or built-ins are not the engine's, and the records the services hand back are copies with no prototype.

### Fixed

- A planted key can no longer change what is billed or blocked. A key on `Object.prototype` named like an option (`strict`, `failClosed`, `settlement.enabled`, `wallets.overdraftNanoUsd`, `holds.ttlSeconds`, `ratingMode`, `markup`), like a field of `@Meter` or `@RequireBudget` (`isSystemCost`, `estimate`, `feature`, `preset`, `tags`, `extract`, `exposeHeaders`), like a field of the handler's result (`usage`), like a field a normalizer builds (`serverToolUse`, the cache, audio, image and reasoning counts, `serviceTier`, a reported cost), like a model (`constructor`, `toString`) or like a field of the request the guard enriched (`hold`) was taken for something the host set: a planted `isSystemCost` made every metered call free, a planted `strict=false` turned off the missing-price refusal, a planted `serverToolUse` billed 10,006,250,000 nano-USD for a call of 6,250,000, a planted `usage` was billed instead of refused with `AI_TOKENS_USAGE_MALFORMED`, and a planted `hold` was captured when the guard had placed none. They are read as the host's own fields (an own field, or one the host's class defines; a getter of a class still counts) and never from the root of the prototype chain.
- A planted key can no longer be persisted by the PostgreSQL adapter. The adapter binds the optional names of its inputs from plain objects, so a planted `limitTokens` of 0 became a hard token limit on a budget (every later call blocked), a planted `cacheReadNanoUsdPerMillion`, `tier*` or `unitRates` became the price of a model (also on the seed path of `seedFromSnapshot`), and a planted `extraUnits`, `requestedModel`, `beneficiary` or `expiresAt` went into a usage row or a wallet entry. Every argument a store takes is copied first, and the price snapshot builds its rows from their own keys, so a key planted before the first import no longer ends up in a seeded row.
- A planted key can no longer change how a service reads a row a store returned or builds from one. A planted `extraUnits` on a stored hold billed a captured call at the table rate plus the planted units (10,006,250,000 nano-USD instead of 6,250,000), a planted `reversesRecordId` reconciled a budget count wrongly, a planted `features` exempted an exhausted budget, a stored budget row with no `tenantId` and a planted `tenantId` passed the tenant check, a planted `isSystemCost` or `feature` dropped records from a usage report (three recorded calls of 6,250,000 each came back as none with `isSystemCost` planted), a planted `expiresAt` made the PostgreSQL store read a grant with no expiry as not spendable (the balance read 0), a planted `limit` or `offset` paged `getEntries`, and a planted `correlationId`, `requestedBy`, `reversesRecordId` or `extraUnits` written into a hash chain made `verifyChain` fail for good. The services read the rows of every store, the library's and the host's, as copies that hold only what the row has, the report filter and the chain hash read their fields as the record's own, and the rows the adapter maps have no prototype.
- A planted `get`, `set`, `value` or `writable` on `Object.prototype` no longer makes every metered call throw. The descriptors the library hands to `Object.defineProperty`, and the descriptor the store guard returns to the engine, have no prototype, and the parts of the internal shapes that read a call's arguments (`nested`, `raw`, `limits`) are the shape's own, so a planted `extraUnits` or `nested` no longer drops a host's tool units or a price's unit rates. A typed error has its own `message`, body, status and `name`, so a `message` planted on `Object.prototype` is not the text of an exception, and the refusal of the realm guard, built without running the constructor of `HttpException`, is not changed by any key planted under those names, whether it is read-only or not.
- A function planted under the name of an optional method of a store (`findStaleReferences`, `pruneApplication`, `pruneGivenBack`, `pruneGivenBackExcept`, `findDebitsBefore`, `findEffectsOwed`, `findEffectsOwedFor`, `clearEffectsOwed`, `seedPrice`, `summarize`) or of a sink is no longer called as the host's, and a key planted under the name of an option of a sweep or of the Redis counter (`pageSize`, `pages`, `keyPrefix`) is not one.
- A hold estimate above what a ledger row stores (2,147,483,647 tokens) is refused with `AI_TOKENS_INVALID_CONFIG` before anything is reserved, and a pending hold replayed with different tool units is refused with `AI_TOKENS_IDEMPOTENCY_CONFLICT`, as `record()` does.

### Changed

- **The library refuses to start, and to move, read or report money, in a process whose `Object.prototype` or built-ins are not the engine's.** The module does not start, and every call that moves, reads or reports money refuses with `AI_TOKENS_INVALID_CONFIG`, before anything is written, while the `Object.prototype` of the process holds a name the engine does not define, lacks one it defines or holds one changed, or while any function of the standard namespaces and constructors it relies on (`Object`, `Reflect`, `Array`, `Math`, `Number`, `String`, `Set`, `Map`, `Date`, `BigInt`, `DataView`, `TextEncoder`, typed arrays and the others, with their prototypes) is not the function it was when the library loaded, or while the name of one of them has been rebound to another object. `Promise`, its prototype and its binding are exempt: tracing and monitoring agents (`dd-trace`, New Relic, `zone.js`) wrap them after load on healthy hosts, and the code that settles a store result or serializes the writes of a call uses `await`, which does not look the global up. `JSON` is exempt too, because a host's own tests spy on it: the keys, the statement parameters and the hashes are made with the `JSON.stringify` the library met when it loaded. The refusal says how many names of `Object.prototype` differ and how many built-ins do, with a count, never a name or a value. A host that extends `Object.prototype` (a `should`-style assertion library, a polyfill) cannot run the library, and neither can a process that patches one of those built-ins in place (`jest.spyOn(Date, 'now')` in a host's own tests): restore the built-in before the call. The global `Date` is one of them, so a fake clock (`jest.useFakeTimers()`) must be restored before the library is called. A symbol on `Object.prototype` is counted whether it is enumerable or not, except the one hidden mark that Jest puts there. The check is made again at every call, and again before the amounts of an estimate or of a capture are computed, so load order does not help.
- The records a service returns as a store returned them (`UsageRecord`, `Budget`, wallet entries and price versions), and the usage a built-in normalizer returns, are copies that have no prototype: they carry the fields of the row, but `record.hasOwnProperty(...)`, `record.toString()`, `String(record)` and `record instanceof Class` are not available on them (use `Object.hasOwn(record, name)`; `JSON.stringify` is unchanged). A getter of a class a store's row is an instance of is read once and counts as a field; a field defined as not enumerable is still a field. A host that mutated a returned record expecting the store to change must call the store.
- A record or list nested deeper than 8 levels, in an argument a store takes or a row it returns, is refused with `AI_TOKENS_INVALID_CONFIG` instead of being handed on.
- A frozen or sealed store object can be given to the services; its methods are wrapped, and a method it lacks stays absent.
- A key that another library put on `Object.prototype` under the name of an optional field of a host option or input (`limitTokens`, `features`, `expiresAt`, a rate) no longer counts. A host that relied on an inherited default put on `Object.prototype` must set the option or the field itself.

## [1.1.21] - 2026-11-21

**Apply:** no migration and no option change is needed. This release fixes billing defects in the usage of a call, all of them present in earlier releases, and some of its changes refuse a usage or a call that an earlier release billed (see Changed). Check a host that passes its own normalized usage or normalizer, and a host that bills tool units.

### Fixed

- A hold that is captured now bills the tool units of the call. `capture()` rated the hold's stored units, which were always empty because a hold never stored `context.extraUnits`, and it overwrote the tool units the provider reported in the usage, so a host that meters through `hold()` and `capture()` undercharged every tool call (seven web searches rated at 10,000,000 nano-USD each billed 70,000,000 less through `capture()` than through `record()`). The hold now stores its units, capture rates the usage's units merged with the hold's (the host's count wins for a unit both name, as in `record()`), and the settled record names the units it billed. The units are written to the existing `extraUnits` JSONB column, so no migration is needed.
- OpenAI chat and Responses bill the audio output tokens once. They were counted in the output total and again as audio output, so a call with 20 audio tokens was billed 200,000 nano-USD too much at a 10,000 nano-USD output rate.
- A count that a response reports twice is billed once: the AI SDK reports reasoning tokens and cache reads at the root of the usage and in its details, and OpenAI-compatible gateways report the cache hit at the root and nested. Two equal values are one count; two values that differ are refused with `AI_TOKENS_USAGE_MALFORMED`, not added.
- Anthropic `cache_creation: {}` beside `cache_creation_input_tokens`, and Bedrock `cacheDetails: []` beside `cacheWriteInputTokens`, billed no cache write. The total is billed when the split reports nothing. A total that disagrees with a non-empty split, and a null entry of `cacheDetails`, are refused.
- The tool units a host puts on a context (`extraUnits`) are validated: a count that is not a whole number from 0 to the largest safe integer is refused with `AI_TOKENS_USAGE_MALFORMED` on `hold()` and `record()` before anything is debited, and the merged units are checked again before a capture settles, where a negative one under-billed or credited the wallet and a fraction threw a raw `RangeError`. For a unit both the provider and the host name, the host's count replaces the provider's (so a host that passes 0 bills 0 for that unit); `-0` is 0; this is the rule `record()` always had and `capture()` now shares.
- A call whose tokens add up to more than 2,147,483,647 (the 32-bit columns of a ledger row) is refused with `AI_TOKENS_USAGE_MALFORMED` before anything is debited. It used to debit the wallet and then fail to store the row.

### Changed

- A tool unit with a count above 0 and no rate in the price's `unitRates` is a missing price, like an unpriced model. It was billed at 0 without a trace. With `pricing.strict` on (the default) the call is refused with `AI_TOKENS_PRICE_NOT_FOUND` before anything is debited; with it off the call is billed for what has a price, `priceMissing` is set on the record and `ai_tokens.price.missing` is raised, by `capture()` as by `record()`. A unit named like an inherited property (`constructor`) is looked up as an own entry of the price only. A host that bills tool units must list a rate for each unit it uses.
- The seeded price snapshot lists a `web_search_requests` rate only for the models that carry one in `src/prices/model-prices.seed.ts`. For the others, with `pricing.strict` on a call with web searches on one of them is refused until the host lists a rate with `upsertPrice`; a host that supplies its own snapshot lists a rate for every unit it bills.
- A negative token or tool unit count, a count past the largest safe integer and a negative provider-reported cost in a normalized usage (from a host normalizer or passed by the host) are refused with `AI_TOKENS_USAGE_MALFORMED`. They were clamped to 0, which hid the defect and billed the call as another. A host that relied on the clamp must fix the usage it passes.

## [1.1.20] - 2026-11-21

**Apply:** no migration and no option change is needed. Every argument a host passes to a public method is read once, at the call, and by the names of its type: a getter or a Proxy trap that answers once and throws afterwards, a date that does the same, and a list or object that cannot be read are refused as `AI_TOKENS_INVALID_CONFIG` naming the argument or the field, and the host's own error and text no longer reach the caller. A sink or a callback of the host that fails no longer fails a call that had done its work. Two behaviours tighten: a text with a NUL character and an amount beyond a `BIGINT` column are refused naming the argument where the store answered with its own error, and an object that lists no key, where the library lists keys itself, is refused where it was read as empty.

### Fixed

- **Apply:** no migration and no option change is needed. A date a caller supplies is read once at the call and used as a copy, so a `Date` subclass that answers its first call and throws on later ones can no longer fail after the call has begun (`budgets.rotateWindow` threw the host's own error after it had persisted the rotation). A text argument that contains a NUL character, and an amount outside what a `BIGINT` column holds, is refused with `AI_TOKENS_INVALID_CONFIG` naming the argument, where the store answered `AI_TOKENS_STORE_ERROR` without naming it. An argument object whose getter throws is refused naming the field (`<field> could not be read`) and no longer surfaces the host's own error. The messages that refuse an amount now state the range, and `wallets.creditRateNanoUsd` and `wallets.overdraftNanoUsd` are refused above it.
- **Apply:** no migration and no option change is needed. A list or an object nested in an input is copied once with the input, element by element, so a Proxy list whose `get` or `length` throws, or a nested getter that answers once, can no longer fail a call after it has begun or put the host's own error in the caller's hands: it is refused as `AI_TOKENS_INVALID_CONFIG`, `<field> could not be read`. A list or nesting beyond the limits is refused the same way, and a key of the host's object that is not a short plain name is written in the refusal as `<key>`.
- **Apply:** no migration and no option change is needed. A telemetry sink (`recordUsage`, `recordDuration`) or an `onThrottle` callback that throws, returns a promise that rejects, or returns a thenable whose `then` throws no longer fails the call that had already done its work (`record`, `capture`, a consumption that throttles): the failure is one log line, `ai_tokens.telemetry.sink_failed` or `ai_tokens.budget.on_throttle_failed`, with the error's name and code and never its message, and a rejection nobody handles is no longer left behind. A sink that does not return, or a callback that never settles, is not guarded: `onThrottle` is awaited.
- **Apply:** no migration and no option change is needed. The reference of a wallet, the scope of a budget lookup and the input of a rate lookup are read once with the call, like the other inputs, and every input read once is read by the names of its type: a getter of a class and a field defined as not enumerable are read, a key planted on `Object.prototype`, of any realm, is not. A field the host's object does not have is absent, whatever else the object holds.
- **Apply:** no migration and no option change is needed. The arguments of the metering calls are read once with the call and by the names of their type. An estimate is read by the names of the variant it is, so a getter named like a field of another variant is not run. A `StreamUsageCollector` passed to `capture()` is used as it is.
- **Apply:** no migration and no option change is needed. A raw provider response is no longer copied before its normalizer reads it: a nested object that answers by a `get` trap and lists no key (a lazy wrapper of `cache_creation`, `prompt_tokens_details`, `completion_tokens_details`) is read by name as before, and the billed amounts are exact; the normalizer reads the response through a view that answers each field the same way every time. An object that lists no key where the library lists keys itself (`serverToolUse` of a usage, `context.extraUnits`, `tags`, `unitRates`) is refused instead of read as empty, which had billed a tool as free: `AI_TOKENS_USAGE_MALFORMED` for the usage, `AI_TOKENS_INVALID_CONFIG`, `<field> could not be read` for the others. A `Buffer`, a typed array and a full embeddings response in a usage are accepted without being walked. A hold estimate that is a Proxy answering by its `get` trap is the variant it answers for.
- **Apply:** a usage whose counts are not counts is refused where it used to be billed for another amount. Every built-in normalizer reads a count that is there as a whole number from 0 to the largest safe integer; a string, `NaN`, `Infinity`, a negative, a fraction or a list is refused as `AI_TOKENS_USAGE_MALFORMED`, where it was read as `0` (a call billed for less than it used) or kept as a negative (billed for more, then clamped). A cached, audio or reasoning count that is more than the prompt or the completion it is part of is refused, where the clamp billed the call as another. A container of counts that is there (`prompt_tokens_details`, `cache_creation`, `server_tool_use`, `cacheDetails`) must be an object (`cacheDetails`, a list), where another type was read as absent and dropped what it held, and a `server_tool_use` entry that is not a count is refused instead of dropped, which had billed a tool as free. An absent count, or `null`, is still `0`. A streamed final usage that cannot be normalized is `AI_TOKENS_USAGE_MALFORMED` and not the normalizer's plain error.

## [1.1.19] - 2026-11-20

**Apply:** no migration is required. These behaviours tighten: an input that used to pass silently or fail raw is refused with a typed error, and an error message no longer repeats a value a host supplied. A budget `policy`, `budgets.defaultPolicy` or `ratingMode` that is not a documented value is refused (a mistyped policy let a limit of 100 pass 180), and a stored policy that is not documented is evaluated as `block`; `budgets`, `wallets`, `ledger` and `ledger.hashChain` set to `null` are refused at startup, where `null` elsewhere now means the default. A date a caller passes to a service method must be a valid `Date`. The message of a refused option or input names it and no longer repeats the value, and the `details` of the runtime errors that name an identifier the caller already holds carry it only when it is a string of at most 256 characters, so a host that matched the text `received <value>` must match the option name. And a driver failure of a public method of the PostgreSQL store is a typed error with the original on `cause`. An argument of the wrong kind to a public method (an identifier that is not a string, a count that is not a whole number, an estimate that is not an object, a `groupBy` that is not an array of the documented dimensions) is refused with `AI_TOKENS_INVALID_CONFIG`, naming the argument, where it failed with a raw `TypeError`, `RangeError` or `SyntaxError` that repeated the value; `scopeResolver` and `fx` must be functions, `holds` and `wallets` objects and `ledger.hashChain` a boolean, so the string `'false'` is refused; a date outside the years 1 to 9999 is refused by name, and a valid `Date` from another realm or a subclass of `Date` is accepted, as it was on 1.1.18. A failure of the connection that Prisma 7's `pg` adapter reports is `AI_TOKENS_STORE_UNAVAILABLE`, not `AI_TOKENS_STORE_ERROR`. Added: a hold-reaper sweep that never settles is abandoned and replaced, with one `ai_tokens.hold_reaper.tick_stalled` line, and the reaper never stops for good.

### Fixed

- **Apply:** no migration and no option change is needed. The public methods refuse an argument of the wrong kind with `AI_TOKENS_INVALID_CONFIG`, naming the argument and never repeating the value; `src/argument-matrix.spec.ts` holds the matrix. Measured by QA with hostile values on every argument: some ended in a raw `TypeError`, `RangeError` or `SyntaxError`, and some of them repeated the value in the message. `ledger.findByIdempotencyKey` is `async`, so its refusal is a rejection, and `reconcile` of a wallet that does not exist is `AI_TOKENS_INSUFFICIENT_CREDITS`, as every other wallet call is, and not the store's raw signal, and a store failure there is a typed store error. A host that passes a number where an identifier is typed as a string now gets a refusal, not a coercion.
- **Apply:** a valid `Date` from another realm (a `vm` context) or a subclass of `Date`, such as the one a clock-shifting test double installs, is accepted: a date is recognized by its internal slot, not by `instanceof Date`. A date from another realm is read as a date at the JSON boundary of `toJsonSafe` (it became `{}`), in the payload hash of `deriveIdempotencyKey` and in the SQL the PostgreSQL store builds. As the date a caller passes to a service method, a Proxy of a `Date` or a subclass whose `getTime`, `valueOf` or `toISOString` throws is refused, and so is a date outside the years 1 to 9999: it is refused as `AI_TOKENS_INVALID_CONFIG` naming the input (`<input> must be a date from the year 1 to the year 9999`) where PostgreSQL's error named nothing (`AI_TOKENS_STORE_ERROR`). A host that used `new Date(8.64e15)` as a date that never arrives must pass a date before the year 10000.
- **Apply:** `scopeResolver` and `fx` must be functions, every option group an object (a group set to `null` takes the default, except `wallets`, `budgets` and `ledger`, which are refused), and `ledger.hashChain`, `pricing.seedFromSnapshot`, `pricing.strict`, `budgets.failClosed`, `settlement.enabled`, `events.emitter` and `telemetry.metrics` booleans: any other value, except `null` where it is allowed (it leaves the option out), throws `AI_TOKENS_INVALID_CONFIG` at startup, naming the option and never the value. Measured on 1.1.18: they were accepted whatever they were, and `ledger.hashChain: 'false'`, which is truthy, switched the hash chain on.
- **Apply:** no migration is needed. A PostgreSQL failure of the connection, not of the call, is `AI_TOKENS_STORE_UNAVAILABLE` (503) when Prisma 7's `pg` adapter reports the cause kind `DatabaseNotReachable`, `ConnectionClosed`, `TooManyConnections`, `SocketTimeout` or `TransactionWriteConflict`; on 1.1.18 such a failure was the driver's own error. A host that matched it for a stopped database must treat 503.
- **Apply:** the message of a refused option or input names what was refused and its bound, and no longer repeats the value: `holds.ttlSeconds`, `holds.reaperIntervalSeconds`, `settlement.graceSeconds`, `settlement.retentionSeconds`, `settlement.enabled`, `content.ttlSeconds`, `reporting.maxExportRows`, `pricing.cacheTtlMs`, `markup`, the Redis store's `closeTimeoutMs` and `commandTimeoutMs`, the `RangeError` of `floatUsdToNanoUsd`, `formatNanoUsd` and `applyMarkup`, the reason for a budget id that does not exist, the `details` of a markup policy that returns an invalid multiplier, which now carry its type and no longer the value it returned, and the `details` of the runtime errors that name an identifier the caller holds (`holdId`, `idempotencyKey`, `budgetId`, `tenantId`, `provider`, `model`, `operation`, `serviceTier`, `recordId`): they carry it only when it is a string of at most 256 characters, and leave the field out otherwise; the budget errors also carry the `dimension` that refused (`cost`, `tokens` or `count`). `AI_TOKENS_FX_REQUIRED`, a refusal at startup, no longer carries the `currency`, and the conflict raised by `reverse()` for a record that does not exist no longer carries the free text of the reason the caller gave, only a fixed reason and the record id. A host that matched the text `received <value>` in a message must match the option name instead. Measured on 1.1.18: each of these messages except the budget id's and the markup policy's `details` ended with `received <value>`, the budget id's ended with the id, the markup policy's `details` carried the value it returned, and a string a host read from its environment appeared in the HTTP body of the error.
- **Apply:** no migration and no option change is needed. A sweep of the hold reaper that never settles (a scan on a dead connection) is abandoned once it has run for longer than ten reaper intervals, or ten minutes when that is longer: the tick logs one `ai_tokens.hold_reaper.tick_stalled` line (the seconds it ran, nothing a store wrote) and starts a fresh sweep. Measured on 1.1.18 with a scan that stays pending: after the first tick no tick started a sweep again, so with a hung scan the reaper stopped reclaiming expired holds for as long as the process lived. At most two sweeps run at once, each holding a store connection until the store gives it up: while an abandoned sweep is still running, a second stall starts no third sweep, with one `ai_tokens.hold_reaper.sweep_blocked` line per run of such ticks, and the reaper sweeps again when either settles. The sweeps are idempotent.
- **Apply:** every date a caller supplies must be a valid `Date`. A value that is not (an Invalid Date, a string, a number, `null`) is refused with `AI_TOKENS_INVALID_CONFIG`, the input named and no value echoed; `undefined` keeps the default where there is one. Measured on 1.1.18 with the in-memory stores: an invalid date was stored as a budget's `anchorAt` or `expiresAt` or as a price's `effectiveFrom`, or raised a raw `RangeError` or `TypeError` (`rotateWindow`, `reconcileWindow`, `record`, `estimateCost`), and `estimateCost` with an Invalid Date answered `0n`; a ledger or wallet-entry filter with an Invalid Date or a string `from` matched nothing, so `verifyChain` on an empty ledger answered `valid: true`.
- **Apply:** no migration and no option change is needed. Every public method of the PostgreSQL store now rejects with a typed `AI_TOKENS_STORE_ERROR` or `AI_TOKENS_STORE_UNAVAILABLE` when the driver fails, with the original failure on `cause` and no driver message in the message, the response or the stack (the details carry at most the driver's `code`, and only when it has the shape of one); the methods that used to pass the raw driver error through (`findById`, `findByIdempotencyKey`, a budget's `upsert` and others) are covered, and the signals the store raises for the service layer (a missing wallet, an idempotency conflict) are unchanged. The log lines of the hold reaper and of its budget-reference and orphan-debit sweepers carry the error's `name` and a code of the shape of one (`ECONNREFUSED`, or the typed code), and no longer carry its message.
- **Apply:** a `policy` of a budget, `budgets.defaultPolicy` and `ratingMode` must be one of their documented values (`block`, `throttle` or `allow`; `rate-table` or `provider-reported`), and a value that is not is refused with `AI_TOKENS_INVALID_CONFIG` at startup, or at `upsertBudget`, naming the option and echoing no value; `undefined` and `null` mean the default. Measured on 1.1.18 with the in-memory budget store: a budget with a limit of 100 and the policy `blocc`, `BLOCK` or an empty string let three consumptions of 60 through (180 spent), where the policy `block` refused the second. A stored budget whose policy is not documented, a row written before this check or edited in the database, is now evaluated as `block`. An option set to `null` takes its default as one left out does, in a group: `wallets.creditRateNanoUsd: null` and `wallets.overdraftNanoUsd: null` were refused with `AI_TOKENS_INVALID_CONFIG` on 1.1.18 and now mean the default rate and a zero overdraft, and a group set to `null` is absent. The exception is a group whose omission leaves a limit or a protection off (`budgets`, `wallets`, `ledger` and `ledger.hashChain`): `null` there is refused with `AI_TOKENS_INVALID_CONFIG` at startup, the option named and no value echoed, because a configuration that failed to load as `null` must not silently remove every limit. Omitted and `undefined` keep the feature off.

## [1.1.18] - 2026-11-17

**Apply:** no migration and no option is required. Two behaviours tighten, and each fails loudly with a typed error where it used to
pass: a value of the wrong type for a limit, an overdraft or an amount (NaN, Infinity, a fraction or a string where a number or a bigint
is required) is refused with `AI_TOKENS_INVALID_CONFIG`, the field named and no value echoed (a `wallets.overdraftNanoUsd` of `NaN`
was accepted; the PostgreSQL store refused the debit in SQL, and the in-memory fake, which compares it in JavaScript, let a debit exceed the balance); and a usage whose token or tool unit count is fractional is refused with
`AI_TOKENS_USAGE_MALFORMED`. The hold reaper no longer overlaps its own sweeps, and the Redis client a `RedisBudgetCounterStore` creates
from a URL fails a command in about `commandTimeoutMs` (default 500 ms) instead of 73 to 107 s against a stopped Redis; a client you pass
in is unchanged.

### Fixed

- **Apply:** nothing changes for a caller that passes what the types say. A value that the types forbid is now refused with `AI_TOKENS_INVALID_CONFIG`, naming the field and echoing no value, where it was accepted before: a `wallets.overdraftNanoUsd` or `wallets.creditRateNanoUsd` that is not a bigint (NaN, Infinity, a fraction or a string), a budget limit that is not a bigint of 0 or more (`limitNanoUsd`) or a whole number of 0 or more (`limitTokens`, `limitCount`), a wallet `grant`, `debit`, `refund` or `adjust` amount that is not a bigint (a string amount reached the store, and the PostgreSQL store credited it as a number), and a hold estimate whose token counts are not whole numbers of 0 or more or whose `amountNanoUsd` is not a bigint of 0 or more. The one that mattered: a `wallets.overdraftNanoUsd` of `NaN` was accepted; on the in-memory fake, which compares it in JavaScript, a debit of 100 went through against a balance of 5, and the PostgreSQL store refused it in SQL. A budget with a NaN or Infinity `limitNanoUsd` or `limitCount` was accepted, and on PostgreSQL every consume then succeeded with that cap not enforced; a fractional limit was refused only with a raw error. The alert thresholds (`budgets.alertThresholds` and a budget's `softThresholds`) must be a list of numbers within (0, 1], where a string such as `'0.5'` used to pass; a grant's `priority` must be a whole number and its `effectiveAt` and `expiresAt` valid dates, where an `Invalid Date` reached the PostgreSQL store, which refused it with an `AI_TOKENS_STORE_ERROR` that names no field; and a usage with a fractional or NaN token or tool unit count is refused with `AI_TOKENS_USAGE_MALFORMED`, where a fractional token count threw a raw `RangeError` from the cost arithmetic and a fractional, NaN or infinite tool unit count was accepted. A negative count keeps its floor at zero.
- **Apply:** no migration and no option change is needed. The hold reaper's timer no longer starts a sweep while the previous one is still running: with a scan that hangs on a degraded store, a sweep used to start on every tick and hold one more pooled connection each time. A skipped run of ticks logs `ai_tokens.hold_reaper.tick_skipped` once. The client a `RedisBudgetCounterStore` creates from a URL is now built with `maxRetriesPerRequest: 1`, the offline queue on and a `commandTimeout` taken from the new `commandTimeoutMs` option (default 500 ms), so a stopped Redis fails a command in about that time instead of 73 to 107 s and the budget service falls back to the database at once. A client the host passes in is the host's, unchanged.
- The PostgreSQL store's typed error repeats the code of the driver error in its `details` only when the code has the shape of one (`P2010`, `ECONNREFUSED`); a code that is a sentence or carries a value is left out, so no text a driver wrote reaches the HTTP body. The original error stays on `cause`.
- The pruning of given-back budget applications now runs for a custom budget store that implements `pruneGivenBackExcept` but not `pruneGivenBack`, when the ledger keeps no markers or none is owed; before, it pruned nothing.

### Changed

- The note on `status: ['released']` reads says to filter on the provider or feature `orphan-claim` client-side, or to list features with `features: [...]`; there is no server-side "not equal" filter.
- The `server` bundle grows to 52353 bytes brotli with the reaper guard and the validation of numbers at the library's boundaries; its budget moves from 51653 to 52383. The `prisma` bundle grows to 15751 bytes (the shape test of a driver error's code); its budget moves from 15744 to 15781. The `redis` bundle is 2125 bytes.

## [1.1.17] - 2026-11-16

**Apply:** no migration. An owed marker older than `settlement.retentionSeconds` used to pause the deletion of given-back budget
applications for every tenant; it now pauses it for the tenants that owe effects only, because a given-back application belongs to a
budget and a budget to one tenant. The sweeper names those tenants from the markers and calls the new optional
`IBudgetStore.pruneGivenBackExcept(before, limit, exceptTenants)`; the Prisma store implements it with no schema change. A custom
budget store that omits it, or a tick whose listing of markers may have been cut at a page, keeps the pause for every tenant, as
before. The tick's line says `given-back pruning skipped for <n> tenant(s): an owed marker is older than the retention` and carries
a count, never a tenant id.

A read that asks for `status: ['released']` returns the claim rows of the orphan-debit give-back (1.1.16) together with released holds. A claim row has the provider and the feature `orphan-claim`, so filter on them when the difference matters; the default reads, which count posted and reversed rows, never include one.

### Fixed

- A hold charged the budget windows of the instant its reservation ran, while its commit, its release, the reaper and the reconcile act on the windows of the instant stamped on its ledger row. When a window boundary fell between the stamp and the reservation, the reservation stayed counted in the window nobody gave back, in the budget store and in a live counter. The reservation, its rollback after a wallet refusal and its rollback after a failed append now locate the windows by the row's instant. A stale-high live counter after a sweep is unchanged: it fails closed and the database decides.

### Changed

- The `server` bundle grows to 51623 bytes brotli with the per-tenant guard and the hold's window fix; its budget moves from 51190 to 51653. The `prisma` bundle grows to 15714 bytes; its budget moves from 15624 to 15744.

## [1.1.16] - 2026-11-16

**Apply:** no migration. A wallet debit that no ledger row stands behind is now given back by the reaper. A keyed `hold()` or
enforced `record()` whose ledger append failed keeps its wallet debit for a retry to replay; one that is never retried used to
leave the debit for good. The reaper now finds such debits once they are older than `settlement.graceSeconds` and younger than
`settlement.retentionSeconds`, appends a released claim row under the call's key that owes the refund, and refunds the wallet
once, under the key and reason of the inline rollback, so a debit that rollback already returned is not returned twice. The
claim row is never counted by a usage report, a cost summary or a budget; a later call on that key is refused with
`AI_TOKENS_IDEMPOTENCY_CONFLICT` and one `ai_tokens.orphan_claim.late_append` warn line, so the grace is a correctness bound for
a keyed call: keep it longer than any wallet debit or ledger append can take. `IWalletStore` gains the optional
`findDebitsBefore`; a custom wallet store that omits it keeps working with this part inactive, and the reaper logs that once at
boot. The Prisma store implements it with no schema change. Its listing reads `ai_wallet_entries` across wallets in `(createdAt, id)` order, which no shipped
index serves, so an installation with a large wallet table should add the partial index the README gives. Create it
`CONCURRENTLY`, outside a transaction, so that it does not block wallet writes. The sweep is correct without it and slower.
The statement is `CREATE INDEX CONCURRENTLY IF NOT EXISTS "ai_wallet_entries_debit_createdAt_idx" ON "ai_wallet_entries" ("createdAt", "id" COLLATE "C") WHERE "type" = 'debit';`.

Do not use the same idempotency key for a `hold()` and a `record()`. They debit the wallet under different keys, and when a call of one kind posts its row first, the sweep finds a row under the key and leaves the orphan debit of the other kind, because a posted row cannot be told apart from a captured hold that shares its debit.

### Changed

- The `server` bundle grows to 51159 bytes brotli with the give-back of orphan wallet debits (the sweeper, the claim and rollback-key helpers, the refund branch and the reaper step); its budget moves from 49790 to 51190. The `prisma` bundle grows to 15594 bytes with the cross-wallet debit listing; its budget moves from 15411 to 15624.

## [1.1.15] - 2026-11-14

**Apply:** run both migrations, `0002_budget_applications.sql` and `0003_effects_owed.sql`, before you update the package.
Both are additive: they create tables, indexes and foreign keys and touch no existing table. The notes below say what each one is for.

**Apply:** run migration `0003_effects_owed.sql` before you update the package. It creates one table,
`ai_usage_effects_owed`, beside the ledger and touches no existing table, so it is additive: rows written before it owe
nothing. The new code writes a marker row in the same statement as a capture, a release and the compensating record of a
reversal, so an installation that updates without the migration fails those writes. The migration's header documents its
rollback. A capture, a release and a reversal whose wallet and budget legs did not run are now finished by the reaper's
ticks, once the marker is older than the new `settlement.graceSeconds` option (default 300; `settlement.enabled` switches it
off, default true). A refund or a budget release that fails during a reversal is no longer logged and lost: the marker stays
and the sweep retries it, and a reversal settles the capture legs its original still owes before it reverses, so the clamp of a budget window at zero cannot absorb part of the reversal. The marker of a reversal keeps the caller's reason, so the sweep refunds with the payload the inline refund sent, and the release of a hold that predates budget keys subtracts its reservation once, under a key of its own, however many times it runs. The sweep re-emits the event a write owes, at least once. A custom `ILedgerStore` that omits the
new optional `findEffectsOwed`, `findEffectsOwedFor` and `clearEffectsOwed` calls keeps working with the sweep inactive for it, and the reaper logs
that once at boot. The ledger table gains no column: the only change a posted row takes is still the annotation of its
reversal.

**Apply:** a budget reference an attempt left behind (it died between taking the movement and writing its ledger row) is now
settled by the reaper's tick, once it is older than `settlement.graceSeconds`: the movement is given back when no ledger
row is the same call, and kept under the committed name when one is, so the window no longer counts a call nobody owns. The
reaper also deletes the record of a budget movement once it was given back, or its ledger row ended and owes nothing, and is
older than the new `settlement.retentionSeconds` (default 604800, 7 days). The module refuses at boot, naming
`settlement.retentionSeconds`, a retention that is not a whole number or that does not exceed both `settlement.graceSeconds`
and `holds.ttlSeconds`, checked on the effective values: a `holds.ttlSeconds` above 604800, or a grace above it, now needs
a `settlement.retentionSeconds` of its own. A custom
`IBudgetStore` gains the optional `findStaleReferences`, `pruneApplication` and `pruneGivenBack` calls and keeps working
with that part inactive. While one step of a call is stuck for longer than the grace the window does not count the call and
can end above the limit; the call is counted in the end. The sweep does not correct a live Redis counter.

**Apply:** a `RedisBudgetCounterStore` built from a connection URL now closes the client it opened when the Nest
application closes: a graceful `quit()` bounded by the new `closeTimeoutMs` option (default 2000 ms), then
`disconnect()`, and nothing for a client that has already ended. A `closeTimeoutMs` that is not a whole number from 1 to
2,147,483,647 is refused at construction with `AI_TOKENS_INVALID_CONFIG`. Before, that connection stayed open after
`app.close()` and the process did not exit on its own. A client you pass to the store is still never closed by it. After
shutdown a URL store refuses further calls.

**Apply:** a store that cannot serve a call now answers `AI_TOKENS_STORE_UNAVAILABLE` (503), where it answered
`AI_TOKENS_STORE_ERROR` (502). The cases are a server that cannot be reached or closed the connection, a connection
pool or a transaction that ran out of time, a statement or lock timeout, a shutdown, and a serialization failure or
deadlock (retryable by design: run the call again). Every other store failure stays `AI_TOKENS_STORE_ERROR` and now
answers 500 instead of 502, because retrying it does not help. A client, a load balancer rule or an alert that matches
502 for the store must match 503 for an outage and 500 for the rest. No `Retry-After` header is set. A unique violation
is still replayed or refused as the 409 conflict. A custom store's errors are classified by the same rules, so a plain `Error` whose message names a closed or terminated connection answers 503. A server that is paused (its
socket stays open and nothing answers) fails after the driver's own connection or transaction wait, so set one: the
`connectionTimeoutMillis` of the pool, or Prisma's `connect_timeout` and `pool_timeout`.

**Apply:** `record({ enforce: true })` now charges the budget and the wallet before it writes the usage record. A call
the budget or the wallet refuses leaves no record, where it used to leave a posted record that had charged nothing, and
a retry of a refused call with the same idempotency key is decided afresh, where it used to return that record as if the
call had been enforced. The ledger no longer holds a record of a refused call. The wallet debit of an enforced call is now
keyed `record:<idempotencyKey>`, or a fresh id when the call has no key, and carries no `usageRecordId`.

**Apply:** the module now refuses at boot, naming the option, a `holds.reaperIntervalSeconds` that is not an integer
from 1 to 2,147,483, a `holds.ttlSeconds` or `content.ttlSeconds` that is not an integer from 1 to 2,147,483,647 (the hold's
expiry date must stay a valid date), and a `reporting.maxExportRows` that is not a positive integer. Before, `NaN` and any interval above
2,147,483 seconds passed, and `setInterval` ran the hold reaper every millisecond, and a fractional value passed as well.
Values such as `0.5` are now refused; use whole seconds.

**Apply:** the budget admin paths are now tenant-scoped, which changes three signatures. `BudgetService.rotateWindow` is
`rotateWindow(budgetId, tenantId, newWindowStart?)` and `BudgetService.reconcileWindow` is
`reconcileWindow(budgetId, tenantId, windowStart)`: pass the tenant as the second argument. If you implement
`IBudgetStore` yourself, `remove`, `findBudgetById` and `setWindowStart` now take a `BudgetKey` (`{ tenantId, id }`)
instead of a bare budget id, so a store written against the old port no longer type-checks and cannot ignore the
tenant; `upsert` must refuse an `id` that belongs to another tenant. The service checks the tenant of what a store
returns, so a store that ignores it is not believed, and it refuses an `upsert` id that the store reveals as another
tenant's; a store that hides another tenant's id behind the key must refuse it in `upsert` itself. `removeBudget`,
`rotateWindow` and `reconcileWindow` answer another tenant's id exactly as an unknown id, and `upsertBudget` with an
id that belongs to another tenant rejects with `AI_TOKENS_INVALID_CONFIG` instead of overwriting it; a tenant that
is not a non-empty string is refused before the store is touched.

**Apply:** `MeteringService.capture` and `release` take the caller as a required second argument:
`capture(hold, caller, usage, preset?, content?)` and `release(hold, caller, reason)`, with `caller` the
`{ tenantId, scope }` from your verified auth context (the context you passed to `hold()` works). TypeScript catches
callers whose usage is typed; a caller whose usage is `any`, or plain JavaScript, is refused at run time with
`AI_TOKENS_INVALID_CONFIG` and the message "capture(hold, caller, usage): the second argument must be the caller
{ tenantId, scope } (since 1.1.15)" (or the `release` form), before anything is read. The interceptor and `meter()`
already hold the context and are unchanged for you.

**Apply:** if you implement `IWalletStore` yourself, `conditionalDebit`, `openGrants` and `reconcile` now
take an optional trailing `now` (a `Date`), which `WalletService` passes when it calls them. A store that compares grants
against a server-side clock must use the `now` it is given; an entry's `createdAt` stays the store's own clock, which orders the entries; a store that
ignores `now` and uses its own process clock keeps working, because that is the application's. `WalletService` takes an
optional injected clock as its fourth constructor argument; the module keeps the wall clock.

**Apply:** run migration `0002_budget_applications.sql` (additive) before you deploy, or the budget feature fails on its first movement. If you
implement `IBudgetStore` yourself, add `consumeWindowOnce`, `adjustWindowOnce`, `commitReference` and `dropReference`. A
movement is applied once per application (a key and a budget id); every attempt that applies or replays it takes one
reference on it, named by the attempt. `consumeWindowOnce` and `adjustWindowOnce` take the reference and answer
`'applied'`, `'replayed'` when the application already moved the same window by the same delta, or `'mismatch'` when it
moved another window or another delta (nothing moves and no reference is taken; the service refuses the key as an
idempotency conflict); `consumeWindowOnce` also answers `'refused'` when a limit stops it, recording nothing. `commitReference` renames the attempt's reference to `row`, the call whose ledger row stands, or
drops it when `row` is already held. `dropReference` drops one reference and subtracts the movement, from the window it
moved, when it was the last. The module refuses a store that lacks them at boot. The uniqueness of the application,
never a read followed by a write, must decide which of several concurrent attempts moves the window, and a take and a
drop of one application must not interleave. A hold that is pending when you upgrade has no application, so releasing it
subtracts its delta as before. The tables hold one row per keyed budget movement and one per reference, and grow with the
ledger until the reaper's budget-reference sweep deletes a row that was given back, or whose ledger row ended, once it is older than `settlement.retentionSeconds`.

### Security

- **High severity: a tenant could delete, rotate, reconcile or overwrite another tenant's budget by its id.** `removeBudget`,
  `rotateWindow`, `reconcileWindow` and `upsertBudget` with an `id` ran against the budget id alone: tenant B calling
  `removeBudget(idOfA, 'B')` deleted A's budget and its windows, and `upsertBudget` with A's id rewrote A's row under
  B. The Prisma store now carries the tenant in every statement (`DELETE ... WHERE id AND tenantId`, a conditional
  `ON CONFLICT` update), the service checks the tenant of every budget a store returns, and the answers match an
  unknown id. Budget ids should be generated by the library or be UUIDs, since refusing a taken id is observable.
- **Medium severity: `capture()` and `release()` trusted the tenant and scope carried on the `Hold` object.** The check
  compared the stored hold with the `Hold` the caller passed, so a `Hold` forged as `{ id, tenantId, scope }`, with the
  tenant and scope copied from the stored record, was accepted, and the record id was the only protection; the
  documentation said the check was against the caller's context. The stored hold must now belong to the `caller` the
  host passes, and another caller's hold answers `AI_TOKENS_HOLD_NOT_FOUND` exactly as an unknown id does. The input
  tokens of an aborted stream came from `hold.estimatedTokens`, a figure the caller could set; they now come from the
  stored hold. SECURITY.md states what the code does.

### Fixed

- **A retry of a refused `record({ enforce: true })` call succeeded without charging anyone.** The record was written
  first and enforced second, so a call refused for credits or budget had left a posted record that said it was
  enforced; the same call retried with its key found that record and returned it, with no wallet debit and no budget
  consumption, and an interceptor-metered handler ran the provider call again for free each time. The record of an
  enforced call now exists only when the call was enforced. When the ledger append of an enforced call does not
  return a row, what is given back depends on what the ledger holds:
  - a key conflict with the row of another attempt: the loser gives its budget consumption back, and keeps its wallet
    debit only when the winning row is the same call shape, so that the debit under the key is the one both share: a
    `record()` row (posted or reversed), enforced, not a system cost, of the same payer, which owns a wallet and owed an
    amount. For any other row (a hold, which reserves its wallet under another key, another payer or scope, a row that
    was not enforced, a system cost or one that cost nothing) the debit was the loser's own and is refunded, and the
    call fails with the key conflict; the exception is a hold that was already captured, which cannot be told from a
    record;
  - another error and no row, with an idempotency key: the budget consumption is given back and the wallet debit
    stays, which a retry with that key replays, so the retry is charged once;
  - another error and no row, without a key: both are given back;
  - another error and a row of the same payer that carries this attempt's instant (the append committed before the error reached the
    caller): the charge stays, and a retry with the call's key replays the row; a call without a key is not replayed,
    so its retry is a new call;
  - another error and a row of another payer or that does not carry this attempt's instant (another attempt wrote it): the rule of the key
    conflict applies;
  - the ledger cannot say whether the row exists: nothing is undone, so the charge stays, and the error is rethrown.

  Two instances that race the same key with records that match can still consume the budget twice for the one record;
  the wallet is debited once. A keyed call whose append failed keeps its wallet debit for the retry to replay, so if the
  price or the markup changes before the retry, the retry's amount differs and it fails with the key conflict while the
  debit stays without a record.
- **Two `hold()` calls with one idempotency key could erase the winner's wallet reservation, or credit the wallet above
  its balance.** The loser of the key conflict refunded its wallet debit under a key nobody replays, although that debit
  was the winner's entry (the wallet key is per wallet and the same for both). Measured on PostgreSQL with two
  instances: one key, two or ten calls, one pending hold and a wallet that had not moved; and a winner that released
  before the loser recovered left the wallet 6,250,000 nano-USD above its start. `hold()` is now serialized per tenant
  and key inside an instance, and a hold whose pending append fails settles by what the ledger holds for the key, with
  the same cases as `record()`: the loser of a conflict keeps the winner's debit when the row is the same payer's
  enforced hold or record in any status (a posted row may be a captured hold or a record, so it counts, which can
  overcharge one reservation but never refunds a settled one) and refunds its own debit otherwise; a keyed hold whose
  append failed keeps its debit for the retry to replay; a hold without a key refunds; an append that committed before
  its error reached the caller keeps its reservation; an append the ledger cannot confirm moves nothing. A keyed hold
  whose append failed and is never retried leaves its wallet debit without a row until the settlement design lands.
- **A record written in the same millisecond as a budget could be left out of a recompute.** A budget's `createdAt`
  anchors its `'total'` and custom windows, and it was stamped by the database (`CURRENT_TIMESTAMP` into a
  millisecond column, which rounds, up to half a millisecond ahead) while the records the window counts carry the
  application clock (a `Date`, which floors); `reconcileWindow` counts records with `occurredAt >= windowStart`, so a
  record from that millisecond fell before the window and the recompute under-counted, the direction that lets
  spend through. The service now stamps a new budget's `createdAt` from its own clock, the one `occurredAt` uses, and
  the store writes it as given (`IBudgetStore.upsert` accepts an optional `createdAt`, kept when the budget already
  exists); a store that does not take it falls back to its own clock, as before.

- **A wallet grant was judged on the database's clock while the application stamped its dates.** Grants were spendable
  from `effectiveAt` until `expiresAt` as the database server read them, so a database clock behind the application's
  kept a grant that had expired by the application's clock spendable (free usage), and a clock ahead of it expired one
  early. The SQL store now judges grants on the `now` the service passes, so the dates and the comparison share the application's clock;
  the entry's `createdAt`, which orders the entries and is the `'fifo'` burn order and breaks ties in the others, stays on the database clock. A grant that the database clock already read as expired when it was written, but the application's clock reads as live, is now credited at the next debit
  or `reconcile`; it used to stay uncredited. A grant the store credited when it was written, because its own clock was ahead, but that is not effective yet by
  the application's clock, no longer funds a debit; before, such a debit was allowed and left no allocation, so the
  grant's expiry charged that amount a second time. Skew between the
  application and database clocks no longer moves a grant; keep NTP running on the application hosts.

- **`reconcile` after a grant's expiry could drive the balance below zero on the next debit.** `reconcile` removed the
  expired remainder from the stored balance without writing the `expiry` entry, and the next debit's sweep wrote that
  entry and removed the same remainder again, so a wallet that held nothing but the expired grant read minus its
  remainder. `reconcile` now expires lapsed grants through the same sweep a debit uses, so the entry is written once
  and a later debit finds nothing left to expire; a second `reconcile` writes no second entry.

- **A budget movement was not safe to repeat.** `consume`, `adjust` and `release` moved a window every time they ran,
  so a keyed call attempted on two instances at once consumed each budget twice when the loser's append returned the
  stored row, and a retry after a failure part-way through several budgets consumed the earlier ones again. Each
  movement is now recorded under what caused it (the call's key, or an operation and a record id) and held by named
  references: a hold's reservation, a `record({ enforce: true })` consumption, a capture settlement and a reversal each
  apply once, an attempt whose append fails gives back only its own reference, and the movement goes back, from the window
  it moved, when the last reference goes. A key met again in another window or with another amount is refused as an
  idempotency conflict instead of being replayed.

### Changed

- The `server` bundle grows from 41597 to 43712 bytes brotli, with the enforcement that now runs before the record is
  written, the settlement of a failed hold append, the option validation, the tenant check of the budget admin paths and the caller check of `capture` and `release`; its budget moves from 42000 to 43740.
- The `server` bundle grows by 55 bytes brotli (to 43777) with the clock `WalletService` passes to the wallet store; its budget moves from 43740 to 43810.
- The `server` bundle grows by 1891 bytes brotli (to 45654) with the keyed budget movements; its budget moves from 43810 to 45700.
- The `server` bundle grows to 49760 bytes brotli with the settlement sweeps (the effects-owed marker and the budget-reference sweep); its budget moves from 45700 to 49790. The `prisma` bundle is 15387 bytes (budget 15411).
- The release workflow now builds, runs its gates and packs in a job that holds no credential, and a second job publishes only the tarball whose sha256 matches the one the build reported, from a commit on `main`. The package you install is the file the gates saw.

## [1.1.14] - 2026-11-13

**Apply:** nothing. No runtime file changed since 1.1.13: the built `dist/` of this release is byte-identical to the
published 1.1.13 (compared file by file), so no behaviour, API or bundle size moves.

### Changed

- A correction to the 1.1.13 read-cost figures for the `./prisma` open-grants read: on a wallet whose grants are all open,
  the gain measured 1.1 to 1.7 times across environments, about 1.7 times in the 1.1.13 figures and 1.1 to 1.4 times
  in an independent run on all-open wallets. With most grants spent it is unchanged within noise, as stated there.

### Documentation

- README: OpenTelemetry is no longer listed as a peer dependency (the library imports nothing from it; you pass an
  `ITelemetrySink`), and the stream collector's fallback is stated as applying only when it is given a `tokenizer`.
  The configuration table covers the options the README relies on, the README is shorter, and it gained a
  "What This Library Does NOT Do" section, placed before Contributing, beside a compact Security Table.

### Internal

- The weekly full mutation run may take 150 minutes instead of 90. With the widened mutation scope a cold run needs
  about 97 minutes, which the old ceiling cut off.
- The weekly full mutation run is split into two shards (`shards: 2`), so the cold run's wall time is divided across two jobs.
- The weekly full mutation run now fails when a unit spec was not run by it (`inventory: enforce`). A spec that reads source
  text from disk instead of executing it cannot run under mutation, so it is listed with its reason in
  `scripts/mutation-inventory.exempt.json`.
- Development dependencies no longer resolve a `minimatch` in the range the advisory covers (quadratic work while
  expanding globstars, fixed in 11.0.1). The 10.x line is overridden to the patched 11; the 9.x copy came from glob 10,
  which minimatch 11 breaks without an error, so glob 10 is moved to 13 and `test-exclude` (Jest coverage) to its
  release on glob 13.
- The images the end-to-end suites start are pinned by digest in one file, `.github/ci-images/Dockerfile`. The
  Testcontainers fixtures read it, the CI and Prisma-matrix pre-pulls read it, and Dependabot's docker ecosystem
  bumps the tag and the digest there together. A unit spec fails if a fixture or a workflow names another image.
- The mutation-testing scope now covers every shipped runtime file. `stryker.config.json` excluded `src/**/index.ts` by
  glob, which also excluded `src/redis/index.ts` (the Redis counter and its Lua scripts, which is not a barrel), and it
  excluded `src/shared/constants/**`, which holds the ledger transition predicates, and left `src/prices` out. The
  widened scope found 33 surviving mutants: the safe-integer bound and the decrement script in the Lua text, the error
  name and message, four branches of the transition predicates, and 25 in the price snapshot and its row builder. They
  are pinned by tests that assert the scripts and the error verbatim, a truth table over every status pair and patch
  key, and a golden fixture of the snapshot (`src/prices/model-prices.seed.golden.json`), so a price change shows as a
  diff to review. `src/stryker-scope.spec.ts` keeps it so: every file reachable from the package entries must be
  mutated or listed with a reason, and a listed barrel, types-only file or end-to-end-owned file must still be one. Only
  `src/prisma/index.ts` stays out, because its statements need a database per mutant and the four-cell Prisma matrix pins
  its behaviour.
- `scripts/mutate-const-tables.mjs` (a development check, not shipped) removes each entry of every `as const` table
  and bumps each plain integer in it, one mutant at a time, and reports the mutants a test command does not kill; it
  fills the gap Stryker leaves, since Stryker does not remove a table entry. Its first run found 40 of 280 mutants
  alive, the entries of the store-port method lists, the default report statuses, the provider and operation
  catalogs and the release annotation fields; whole-table tests now pin all of them.

## [1.1.13] - 2026-11-07

**Apply:** the usage `query` and the wallet-entry `listEntries` of the `./prisma` store now reject with
`AI_TOKENS_STORE_ERROR` when the database fails them, for example on a `limit` or `offset` that is not a number. The
Prisma error rides on the exception as `cause`, and its code is in the body, as for the usage append and the wallet-entry writes. Before, the
raw Prisma error propagated. If your code catches `PrismaClientKnownRequestError` around these two calls, read it from
the exception's `cause` instead. A call that succeeds is unchanged.

### Changed

- The `./prisma` bundle grows from 12263 to 12391 bytes brotli, with the grant-remainder read and the error handling below; the
  server bundle is unchanged at 41597. Both are within their budgets (15000 and 42000).
- The `./prisma` store computes each grant's unspent remainder once per grant, by an index lookup on its allocations
  (`LEFT JOIN LATERAL`), where it summed them twice per grant, once to filter and once to select. It affects the
  open-grants read that every debit makes and the balance that `reconcile()` computes. The rows, their order and the
  allocation trail are the same as before (a test compares them against the earlier query on a wallet holding every
  kind of grant), and nothing is migrated. The plan stays a lookup per grant when the statistics are stale: a test
  grows one wallet after the last `ANALYZE` and asserts the statement still has no grouped aggregate and stays within
  a small multiple of the per-grant read. Measured on PostgreSQL 16 with other wallets present, in both a freshly
  analysed table and one grown since its last `ANALYZE`: a wallet of 3,001 grants all open reads its open grants in
  about 35 to 40 ms against 65 to 70 ms before, and its debit takes 36 to 44 ms against 62 to 72 ms. With most grants
  spent (1,000, 3,001 and 10,000 grants) the read and the debit are unchanged within run-to-run noise. The cost still
  grows with the wallet's grants and allocations; it is not constant.

### Fixed

- **A `limit` or `offset` the database cannot read as a number leaked a raw Prisma error.** The usage `query` and the
  wallet-entry `listEntries` of the `./prisma` store now reject with `AI_TOKENS_STORE_ERROR`, carrying the Prisma code
  (`P2010`) in the body and the driver error as `cause`, as the usage append and the wallet-entry writes already did. A call with numeric bounds
  is unchanged.

### Internal

- The end-to-end CI job pre-pulled `postgres:16-alpine` and `redis:7-alpine` while the fixtures start `postgres:16` and
  `redis:7`, so the warm-up cached images the run never used. It now pulls the tags the fixtures start, and a unit
  spec compares the pre-pulls of `ci.yml` and `prisma-matrix.yml` with the images the end-to-end suites start.

### Documentation

- `docs/occurred_at_repair_design.md`: the design of a repair for shifted `occurredAt` values that
  proves each correction against the stored hash. It is a design; nothing is implemented. The README links to it.
- README, Wallets & Budgets: what a debit costs as a wallet grows, with the measured figures.
- README, Verifying the hash chain: what a host sees from records written by 1.1.11 or earlier on Prisma 6 under a
  non-UTC session zone (`verifyChain` reporting `valid: false` from the earliest such record, date ranges that miss
  them, a hold reaper that is correct for them), why it is not tampering, how to tell them apart, and the one case in
  which a bounded `verifyChain` verifies the records written after the upgrade. SECURITY.md points to it.

## [1.1.12] - 2026-11-07

**Apply:** importing `@bymax-one/nest-ai-tokens/prisma` no longer loads `@prisma/client`. Before, the subpath imported it
at load, which throws `Cannot find module '.prisma/client/default'` on a Prisma 7 host that uses the `prisma-client`
generator (it requires a custom `output` and leaves nothing for `@prisma/client` to load), so the store could not be
constructed there. The store now composes its SQL itself and runs it through the three members of the client you pass
it, `$queryRawUnsafe`, `$executeRawUnsafe` and `$transaction`. Every value is a bound parameter and the text is built
only from constants and checked column names, so nothing a caller passes can become SQL text. The constructor takes the
structural type `PrismaRawClient` (exported, with `RawExecutor`) in place of `PrismaClient`. A client from either major
and either generator satisfies it, and a call that passes a `PrismaClient` compiles as before (checked against Prisma
7.10.1); a wrapper that offers only the tagged `$queryRaw` and `$executeRaw` does not. The unique-violation check
recognises Prisma's error by its name and code, not by its class.

**Apply:** on Prisma 6, a `Date` is now read as a UTC timestamp whatever the zone of the database session. Prisma 6's
engine sends a `Date` as an instant, and the store's date-time columns are `TIMESTAMP(3)` without a zone, so on a
database whose session zone is not UTC the database converted it with that zone whenever it was compared with, or
stored in, one of them. Measured: the hold reaper's cutoff and the detection of shifted usage records were wrong under
`Asia/Tokyo` and `America/Sao_Paulo` sessions, and every other statement that binds a `Date` goes through the same
path. Prisma 7's adapter sends a zoneless UTC string and was not affected. The store now sends each `Date` as an ISO
string and reads it as `($n::timestamptz AT TIME ZONE 'UTC')`, which gives the same value on both majors in every
session zone. If your database session zone is UTC, nothing changed for you. Rows that an earlier version wrote on
Prisma 6 under another zone keep their shifted instants: nothing marks them, so this release cannot repair them. The date-time columns must stay `timestamp` without a zone.

**Apply:** `BudgetService.upsertBudget` now validates the window kind and throws `AI_TOKENS_INVALID_CONFIG` for anything
but `'day'`, `'week'`, `'month'`, `'total'` or `{ customSeconds }` with a positive whole number of seconds up to
3153600000 (100 years). Before, any value was stored, and a kind outside the union (for example `'hour'`) or a bad
custom length made the window start an invalid date, so every later record for that scope threw a `RangeError` after the
record was posted. A budget that an earlier version stored with such a value stays in the table and keeps failing:
remove it with `removeBudget` and define it again.

### Changed

- The `./prisma` bundle grows from 11253 to 12263 bytes brotli, because it carries its own SQL composition, and the
  server bundle from 41408 to 41597 bytes, with the window validation. Both are within their budgets (15000 and 42000).

### Fixed

- **Importing the `./prisma` subpath failed on a Prisma 7 host with the `prisma-client` generator.** See the first note
  above.
- **On Prisma 6, a `Date` was read in the session's zone on a database whose zone is not UTC.** See the second note
  above.
- **`upsertBudget` stored a window kind that made every later record for the scope throw.** See the third note above.

### Documentation

- The README says that the store does not load `@prisma/client`, which members of the client it uses, and that the
  date-time columns must stay `timestamp` without a zone. Its subpath table names your Prisma client, not
  `@prisma/client`, as what `./prisma` depends on.

### Internal

- `pnpm check:file-length` fails a tracked source file over 800 lines unless it is frozen on
  `scripts/file-length-baseline.json`, where an entry can only shrink or go. The Prisma SQL builders, the statement type and the executors are in the unit coverage gate and in the
  mutation scope; only the store, `src/prisma/index.ts`, stays with the end-to-end suite. A CI job runs the store
  against Prisma 6.19.3 and 7.10.1, each with `prisma-client-js` and with `prisma-client` and a custom output.

## [1.1.11] - 2026-11-07

**Apply:** a budget charge, its rollback and its reversal now locate the same window, the one that holds the record's
`occurredAt`. Before, `reverse()` released the budget from the window of the current time, so a reversal after a window
boundary took the amount off the new window (clamped at zero) and left the window that had been charged still charged:
a tenant could then spend up to about twice a `'block'` limit in the new window. 1.1.10 fixed this for holds and left
reversals out. `BudgetService.consume` now accepts an optional third argument, the instant that locates the windows, as
`release` and `adjust` do; existing callers are unaffected. A record written with `enforce: true` and a back-dated
`occurredAt` was charged to the window of the current time and is now charged to, and checked against the limit of, the
window of its `occurredAt`; the rollback after a failed wallet debit uses the same window. Charges that an earlier
version left in a window stay there, and a reversal of a record written before this version releases the window of its
`occurredAt` even where the charge had landed in another.

**Apply:** `LedgerService.verifyChain` now reports forks. When two or more verified records name the same predecessor, the
`valid: true` result carries `forks`, a list of `{ parentHash, records: [{ id, createdAt }] }` with the siblings oldest
first; the key is absent when there is no fork, and the chain stays valid, because a fork alone is not proof of
tampering. Before, such a chain verified with nothing said. A fork among records written after you upgraded to 1.1.8 or
later with the official adapter is unexpected: investigate it. The adapter links each record to the single tail under a
per-tenant lock, so it does not create one; an older fork can be benign. The library cannot tell the two apart, so
compare the siblings' `createdAt` with the date you upgraded. The `ai_tokens.chain.verified` audit event gains
`forkCount` when there is a fork. `ChainFork` is exported as a type; callers that ignore the new field are unaffected.

### Changed

- The server bundle budget in `pnpm size` moves from 41000 to 42000 bytes brotli. The bundle grew from 40970 to 41408
  bytes with the two changes above; the budget now leaves about 600 bytes of headroom instead of 30.

### Fixed

- **A reversal after a budget window boundary credited the wrong window.** See the first note above.
- **A back-dated `enforce: true` record was charged to the window of the current time.** See the first note above.
- **`verifyChain` accepted a forked chain without reporting it.** See the second note above.

### Documentation

- The README describes the `forks` field of `verifyChain` and the reading an operator should give it, and its artifact
  size table shows the current server size and budget.

## [1.1.10] - 2026-11-06

**Apply:** a hold now settles against the budget window it consumed. Before, `capture()`, `release()` and the hold
reaper located the window from the current time, so a settlement after a window boundary (an hourly window and a
one-hour hold lifetime make this ordinary) took spend off the new window, clamped at zero, and left the reservation in
the old one for good. A tenant could then spend up to about twice a `'block'` limit inside one window: with a daily
limit, a hold taken at 23:59 and released at 00:10 reduced the new day by the reserved amount. `BudgetService.release`
and `BudgetService.adjust` accept an optional third argument, the instant that locates the windows; existing callers
are unaffected, and the library passes the hold's own `occurredAt`. Reservations that an earlier version left in a
past window stay there and no longer count against anything but that window. A reversal of a posted record still
locates the window from the current time.

**Apply:** `MeteringService.record()` and the post-hoc path of the interceptor now floor negative usage at zero, as
`capture()` has since 1.0.4: every token count and a provider-reported cost below zero is recorded as zero. Server-tool
unit counts that the usage reports below zero are floored on `record()` too; units the host passes in
`context.extraUnits` are taken as given. Before, a payload that a normalizer turned into a negative count (OpenRouter's `prompt - cached`, a
negative `usage.cost`) was written as a negative ledger row, and an enforced call lowered the spend of a budget by that
amount. Rows already written keep their negative values; list them with a query for a negative `billedCostNanoUsd` or
token count on `ai_usage_records`.

**Apply:** `BudgetService.reconcileWindow` now counts a reversal once, as the live accounting does. Before, the
reversed record and its compensating record each added 1 to `spentCount` while the live release took 1 away, so after
a reconcile a budget with `limitCount` answered `AI_TOKENS_QUOTA_EXCEEDED` earlier than its limit: with a limit of 3,
two records and one reversal reconciled to a count of 3. The cost and the tokens already netted to zero. A window that
a reconcile of an earlier version inflated keeps the inflated count until it rotates or `reconcileWindow` runs again
on this version, which recomputes the count from the ledger.

### Fixed

- **A hold settled after a budget window boundary took spend off the wrong window.** See the first note above.
- **`record()` wrote negative usage that `capture()` already floored.** See the second note above.
- **`reconcileWindow` counted a reversal twice in `spentCount`.** See the third note above.

### Documentation

- README Quick Start section 2 registers the module with a `scopeResolver`; without one, enabling `budgets` fails at
  boot with `AI_TOKENS_INVALID_CONFIG`, and the snippet did not boot. A test now boots the module that section
  declares, so a README snippet that does not boot fails the build.
- The README says that `enforce` is part of the request, so a retry with another value fails with
  `AI_TOKENS_IDEMPOTENCY_CONFLICT`; that a `vercelAiSdk` hold sized by a token count or an amount, and its capture, carry
  the provider `openai`, while a `vercelAiSdk` record has no provider; and that a price row belongs to one provider id, so the same model id under
  another provider is not priced from it.

## [1.1.9] - 2026-11-06

**Apply:** every timestamp column the store writes is now stamped on the UTC clock; before, a budget and a wallet took the database session zone from the
column default, in a `TIMESTAMP` column without a zone. A `'total'` budget with no `anchorAt` starts its window at the budget's
`createdAt`. On a database whose session zone is east of UTC (for example `Asia/Tokyo`, +9 hours) that start lay in
the future, so `BudgetService.reconcileWindow` found no record in the window, set its spend to zero, and a tenant
that had reached its limit was allowed past it: with a limit of 1000 tokens, two calls of 400, a `reconcileWindow`
and a third call of 400, the third call was accepted. West of UTC (for example `America/Sao_Paulo`, -3 hours) the
start lay in the past, so a recompute can count up to the offset of spend from before the budget existed. A custom
window with no `anchorAt` is aligned to `createdAt` too, so its boundaries sat off by the offset. Nothing changes on a database whose zone is UTC. A budget written by an
earlier version on a database whose zone is not UTC keeps its shifted `createdAt`: nothing marks it, so this
release cannot repair it. The query below lists the budgets that anchor their window to `createdAt`, with the
zone of the session that runs it and the hours from the current UTC instant to `createdAt`. To repair a listed
budget, upsert it again with `anchorAt` set to the instant it was created: the window is then anchored to `anchorAt`,
and `reconcileWindow` for the window start recomputes its spend from the ledger. Wallet `createdAt` and `updatedAt`
are only reported, and no code path compares them with an instant.

```sql
-- Budgets whose window is anchored to createdAt: a 'total' window, or a custom window, with no anchorAt. A budget
-- stamped by the database in its session zone has createdAt shifted by that zone's offset. hoursFromNow is createdAt
-- less the current UTC instant, so it is conclusive for a budget created in the last day: about +9 for Asia/Tokyo and
-- about -3 for America/Sao_Paulo. For an older budget, compare createdAt with the time you know it was created.
-- sessionZone is the zone of the session running this query.
SELECT current_setting('TimeZone') AS "sessionZone", b."id", b."tenantId", b."scopeType", b."scopeId", b."window",
       b."createdAt",
       round((extract(epoch FROM (b."createdAt" - (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'))) / 3600.0)::numeric, 1) AS "hoursFromNow"
FROM "ai_budgets" b
WHERE b."anchorAt" IS NULL AND (b."window" = 'total' OR b."window" LIKE 'custom:%')
ORDER BY b."createdAt";
```

### Fixed

- **A `'total'` budget could lose its spend on a recompute east of UTC, so a tenant at its limit was allowed past it.** See the note above.

## [1.1.8] - 2026-11-06

**Apply:** the creation and update times of a usage record (`createdAt`, `updatedAt`) are now stamped on
the UTC clock. Before, the database filled them in its session time zone, in a `TIMESTAMP` column without
a zone, while the hold reaper compares `createdAt` with an application instant in UTC. On a database
whose session zone is west of UTC (for example `America/Sao_Paulo`, -3 hours) every pending hold looked
older by the offset, so the reaper released it early (on its next tick when `holds.ttlSeconds` is shorter than the offset), and a
`capture()` for it failed with `AI_TOKENS_HOLD_EXPIRED`. East of UTC (for example `Asia/Tokyo`, +9 hours)
an expired hold kept its reservation for the offset past the TTL. The `createdAt` a record returned was
off by the offset too. Nothing changes on a database whose zone is UTC. Records written by earlier
versions on a database whose zone is not UTC keep their shifted values: nothing marks them, so this
release cannot repair them, and the reaper cannot tell them from new ones. A pending hold created before
the upgrade is judged on its old value until it ends, at most one TTL (east of UTC, the TTL plus the
offset). The query below lists records whose `createdAt` is far from their `occurredAt`, with the zone of
the session that runs it and the hours apart; a record backfilled with an old `occurredAt` is listed too,
so compare the hours with the offset of the zone your connections use.

```sql
-- Usage records whose createdAt is far from their occurredAt. A record stamped by the database in its session zone
-- has createdAt and updatedAt shifted by that zone's offset: hoursApart is about -3 for America/Sao_Paulo and +9
-- for Asia/Tokyo. sessionZone is the zone of the session running this query: compare hoursApart with the offset of
-- the zone your connections use. A record backfilled with an old occurredAt is also listed.
SELECT current_setting('TimeZone') AS "sessionZone", r."id", r."tenantId", r."idempotencyKey", r."status",
       r."occurredAt", r."createdAt",
       round((extract(epoch FROM (r."createdAt" - r."occurredAt")) / 3600.0)::numeric, 1) AS "hoursApart"
FROM "ai_usage_records" r
WHERE abs(extract(epoch FROM (r."createdAt" - r."occurredAt"))) > 60
ORDER BY r."createdAt";
```

**Apply:** the tail of a tenant's hash chain, the record the next chained record links to, is now the
hash that no other record of the tenant names as its predecessor. Before, it was the settled record with
the latest `createdAt`, which is wrong in the hour a daylight saving clock repeats, and which would have
been wrong for records stamped by two clocks. `LedgerService.verifyChain` accepts a chain in which two
records name the same predecessor (it recomputes each hash and checks that each predecessor exists), so a
chain that forked is reported as valid. The query below lists the records that share a predecessor.

```sql
-- Hash-chained usage records that share a predecessor. A chain is a line, so two records with the same prevHash mean
-- it forked. LedgerService.verifyChain recomputes each hash and checks that each predecessor exists, so it accepts a
-- fork; this query finds it. "ids" lists the records that name the same predecessor, oldest first.
SELECT r."tenantId", r."prevHash", count(*) AS "records", array_agg(r."id" ORDER BY r."createdAt", r."id") AS "ids"
FROM "ai_usage_records" r
WHERE r."prevHash" IS NOT NULL
GROUP BY r."tenantId", r."prevHash"
HAVING count(*) > 1;
```

A chained append now reads the tenant's rows twice instead of once (about 4 ms against 2
ms at 10,000 rows, 20 ms against 10 ms at 100,000), under the per-tenant lock it already took. No exported
type or signature changes, and no schema or migration.

**Apply:** the body message and the `message` of the refusal for a reserved wallet key held by an entry the
store did not write (`AI_TOKENS_INVALID_CONFIG`, as in 1.1.7) now say so, in place of the generic text that
sent you to markup, limits and currency configuration. The code, the status, the `details.reason` and the
`cause` are unchanged; if you match on the old message text, match on the code.

### Fixed

- **A pending hold was released on the next reaper tick on a database west of UTC, and kept past its TTL
  east of it.** See the first note above.
- **The tail of a hash chain depended on creation times in one clock.** See the second note above.
- **The refusal for a held reserved key sent the operator to the configuration.** See the third note above.

## [1.1.7] - 2026-11-01

**Apply:** a debit that 1.1.6 refused with `AI_TOKENS_STORE_ERROR` because an entry the store did not
write holds the key `expiry:<grantId>` of an expired grant is now refused with `AI_TOKENS_INVALID_CONFIG`,
status 500. If you alert on the old code for this case, alert on the new one. The response body holds the
code and a fixed reason; the wallet, the key and the grant are on the error's `cause`, which is not part
of the body, so log `exception.cause` on the server (the README shows a minimal filter).

**Apply:** the store used to take any entry that held the key `activate:<grantId>` as proof that the
grant was credited. An entry written outside the store with that key (a marker of amount zero, say)
therefore made the grant look credited, and it was never credited. An activation is now the
`adjustment` entry with the reason `grant activated` and the grant's amount, and a key held by an entry
of another shape refuses the debit and the `reconcile()` that need it with the same error as above; 1.1.6 refused nothing in this case. The query on the
1.1.6 Release page matches the key, the type and the reason but not the amount, so it does not find an
entry of the right type and reason with another amount; the query on the 1.1.7 Release page does. Entries the store wrote
in 1.1.6 have the shape the store looks for, so an upgrade changes none of them. No exported type or
signature changes, and no schema or migration.

### Fixed

- **A store error lost the failure that caused it.** The store, the wallet service and the fail-closed
  budget path replaced the original error with an `AI_TOKENS_STORE_ERROR` that held at most the Prisma
  code, so no log could show what had failed. The original error is now the exception's standard
  `cause`: it is not enumerable and is never in the response body or in the serialized exception. A
  logger that prints `cause` shows it; Nest's default exception filter does not log an `HttpException`
  at all. On Prisma 7 with the `pg` adapter the cause of a rejected password names the user and not the
  password, and the cause of a refused connection holds no password, which the end-to-end suite asserts.
- **An entry holding a grant's activation key made the grant look credited.** See the second note above:
  the activation is recognised by its shape, and a key held by an entry of another shape refuses the
  debit and the `reconcile()` with the wallet, key and grant on the cause.

### Documentation

- The README says that `getBalance()` reads the stored balance, so it can trail the clock until a debit
  or `reconcile()` credits a grant that has just fallen due, and shows how to log the cause of a store
  error.

## [1.1.6] - 2026-11-01

**Apply:** the first `debit` or `reconcile()` on a wallet after the upgrade credits every grant that
is due, not expired and was never credited, which the previous store left out of the balance. On a
database whose session time zone is west of UTC that includes grants that were refused for as many
hours as the offset after they were appended, and on any zone it includes a grant written with a
future `effectiveAt` that has since come due. The credit is one `adjustment` entry keyed
`activate:<grantId>` with the reason `grant activated`; it is bookkeeping, so a report that lists
adjustments should skip it. A wallet that `reconcile()` had already corrected is not credited a
second time: after an activation the stored balance is set to the signed sum of the entries, so a
balance that drifted from the ledger is also brought back to it. On a wallet with about 300,000
entries the activation query takes 2.5 ms and that recompute about 90 to 140 ms, once, in the
debit that activates a grant.

**Apply:** the PostgreSQL store now compares and writes every wallet entry timestamp on one clock,
`CURRENT_TIMESTAMP AT TIME ZONE 'UTC'`, where it wrote `createdAt` in the database session zone and
`effectiveAt` in UTC. Nothing changes on a database whose zone is UTC. On a database east of UTC,
the `createdAt` of entries written by earlier versions is ahead of UTC by the offset, so a grant
appended then may have been credited, spent, or expired up to that many hours early; the history
does not record which, and this release cannot repair it. Review the wallets of such a database
against your own records. Entries written from now on are in UTC.

**Apply:** wallet entry keys that start with `activate:` or `expiry:` belong to the store, and
the PostgreSQL store now refuses them, for `grant`, `refund`, `adjust` and `debit`, with
`AI_TOKENS_INVALID_CONFIG`. A key of yours in those namespaces that is already stored is not
touched, except an `expiry:<grantId>` key held by an entry other than the store's own expiry of that
grant: the debit that would sweep that grant is refused until the entry is corrected. No exported
type or signature changes, and no schema or migration.

### Fixed

- **A grant that was not due when it was appended was never credited by a debit.** The store decided
  once, at append, whether a grant counted toward the balance, by comparing its `effectiveAt` with
  the row's `createdAt`. A grant that failed the comparison got a balance delta of 0 and nothing
  credited it later: `debit` reads only the stored balance, and only `reconcile()` recomputed it,
  by a different rule. A grant is now credited when it falls due, at the next debit or `reconcile()`,
  exactly once, also when debits race for it.
- **The two timestamps were in different time zones.** `effectiveAt` is written by the application
  as a UTC instant and `createdAt` by the database from `CURRENT_TIMESTAMP`, in its session zone,
  and both columns have no zone. Measured on three databases, an immediate grant was refused for
  three hours on `America/Sao_Paulo`, and on `Asia/Tokyo` a future grant was credited nine hours early
  and a live grant counted as expired nine hours early. The sweep, the burn-down and the open-grants
  query now use the database clock in UTC, and the three zones pass the same cases.
- **A grant credited by `reconcile()` never expired, and the burn-down could draw on a grant that was
  not credited.** The expiry sweep only considered grants credited at append, and the burn-down
  selected due grants whether or not the balance counted them. Both now consider credited grants
  only, in the configured order.
- **Two debits sweeping the same expired grant collided.** Both wrote `expiry:<grantId>` and one was
  rejected with a ledger conflict. Debits, activations and sweeps of one wallet are now serialized on
  the wallet row, so each expired grant is swept once and both debits succeed.

## [1.1.5] - 2026-11-01

**Apply:** `record()` and `meter()` now treat a second call with an `idempotencyKey` the ledger already
holds as a replay of the first when the request is the same: it returns the stored record and does
nothing else. A retry that used to fail with `AI_TOKENS_IDEMPOTENCY_CONFLICT` only because its
defaulted `occurredAt` or the price had changed now returns the stored record, so code that handled
that conflict by recording again no longer reaches that branch. A request that differs still fails
with the conflict. The effects of a replay are not repeated: if the first call stopped after writing
the record and before its budget or wallet movement, the retry will not make it.

**Apply:** a host that seeded its own price rows under `azure-openai` or `vertex` and relied on a
hold (`hold()` or `meter()` with a `{ tokens }` estimate) to price through them must re-key those
rows to `openai` or `gemini`, or pass the provider in the estimate (`{ provider, model, ... }`).
`record()` never read those rows, and the `azureOpenai` and `vertex` presets now carry the provider
their records already had.

**Apply:** `providerPresets.openaiCompatible(id)` now records `id` as the provider, where it recorded
an empty one. A `record()` call for a response that carries no model, such as a Bedrock Converse
response, now stores `context.baseModel` as the model when you pass one, as `hold()` and `capture()`
already did. A retry, with the same `idempotencyKey`, of a call that an earlier version stored with
`pricing.strict: false` and an empty provider now fails with `AI_TOKENS_IDEMPOTENCY_CONFLICT`. No
exported type or signature changes, and no schema or store change.

### Fixed

- **A retry of `record({ enforce: true })` consumed the budget a second time.** Every published
  version from 1.0.0 to 1.1.4 runs the same sequence after the ledger write: the events, the
  telemetry, the content capture, then the budget consume and the wallet debit. When the retry
  repeated the stored request exactly (the same `idempotencyKey` and the same `occurredAt`, which is
  how a backfill or a job-start timestamp retries), the ledger returned the stored row and the whole
  sequence ran again. Measured on the code after 1.1.4, which leaves this path as it was, with budgets, wallets, an event sink, a telemetry
  sink and a content store attached: the budget spend, call count and token count doubled
  (1,250,000 nano-USD, 1 call, 1,500 tokens became 2,500,000, 2 calls, 3,000 tokens), a second
  `usage.recorded` event, a second usage measurement and a second content capture were produced,
  and the wallet balance did not move again because its debit is keyed by the record. A host that
  passes `occurredAt` and enables budgets was affected on any retry. A retry now returns the stored
  record and runs none of it, and `meter()` called without an estimate records no duration for it.
- **A retry that left out `occurredAt`, or came after a price change, failed with a conflict.**
  `occurredAt` defaults to the current time and the ledger's payload hash included it, together with
  the price version and the costs, so a retry made a moment later was a different payload. The
  README Quick Start's `idempotencyKey: deriveIdempotencyKey({ jobId })` therefore did not make the
  retry return the stored record. A retry is now compared on what the caller supplied and the
  provider reported (every request field, and `occurredAt` only when the retry passes one), not on
  what was computed while serving the call, and returns the stored record at its original cost.
- **A hold and a record made from the same preset used different providers.** `record()` stamped the
  provider its normalizer returned (`openai` for `azureOpenai`, `gemini` for `vertex`), while
  `hold()` stamped `preset.provider` (`azure-openai`, `vertex`) and `capture()` priced with that. No
  seeded row exists under those ids, so a held Azure or Vertex call threw
  `AI_TOKENS_PRICE_NOT_FOUND` with `pricing.strict` on and was settled at cost 0 with it off. The two
  presets now carry `openai` and `gemini`, and a test pins that every preset's `provider` equals the
  one its normalizer stamps.
- **`providerPresets.openaiCompatible(id)` now records `id`.** Its normalizer cannot know the id, so
  the record's provider was `''`: a call threw `AI_TOKENS_PRICE_NOT_FOUND` with `pricing.strict` on
  and was stored with provider `''` at cost 0 with it off, whatever seeded rows existed for
  `deepseek`, `xai` or `groq`.
- **`record()` names the model after `baseModel` when the response carries none.** A Bedrock Converse
  response has no model id, so the record's model was `''` while the same call through `hold()` and
  `capture()` stored `baseModel`. A model the response did carry is never replaced. The
  idempotency payload keeps hashing the model the response carried, so a retry of a Bedrock call
  whose first attempt an earlier version stored with the empty model still returns that stored
  record, and a different call under the same key still conflicts.
- `providerPresets.openaiCompatible(id)` stamps `id` into the idempotency payload, which earlier
  versions left empty. A retry, with the same `idempotencyKey`, of a call that an earlier version
  stored with `pricing.strict: false` (provider `''`, cost 0, `priceMissing`) now fails with
  `AI_TOKENS_IDEMPOTENCY_CONFLICT` instead of returning the stored record. Under the default
  `pricing.strict` such a call threw and stored nothing.
- The `vercelAiSdk` preset still records no provider on purpose (the SDK does not say which vendor
  served the call), so such a record fails loudly instead of being priced from the wrong vendor's
  rows. Its documentation said the context could override the provider; nothing does, and the text now
  says so. A test pins that a held non-OpenAI model is never priced from an `openai` row.

### Changed

- The `server` bundle size budget in `scripts/check-size.mjs` is 41,000 B brotli (it was 40,000 B).
  The idempotent replay path in `record()` (per-key serialization, request-field matching, the
  shared field-role table) outgrew the previous budget. The other budgets are unchanged.
- The declaration build strips members tagged `@internal`, and the published-surface gate fails when a
  name tagged `@internal` in `src` reaches a built `.d.ts` or `.d.cts`.

### Documentation

- The README says what a retry with the same `idempotencyKey` returns and what it leaves alone, that
  calls with one key run one at a time within one service instance, and that two simultaneous calls
  with one key on different instances can still both run their effects. A test runs the Quick Start
  twice, also after a price change, and pins that it stores one record.
- The Quick Start passed `res.usage` to `record()` with the OpenAI preset, which throws
  `AI_TOKENS_USAGE_MALFORMED` because the normalizer reads `model` and `usage` from the whole
  response; it now passes `res`. The examples also used `gpt-4o`, which the price seed does not
  cover, so under the default `pricing.strict` they threw `AI_TOKENS_PRICE_NOT_FOUND`; they now use
  the seeded `gpt-5-mini`. A unit test runs the Quick Start flow so the example cannot drift again.
- The README now says which presets are priced from which seeded rows. The `azureOpenai` and
  `vertex` presets record provider `openai` and `gemini`. It
  also says that a Bedrock Converse response carries no model id, so the record's model is
  `baseModel` when the caller passes one and `''` otherwise, and it explains the `vercelAiSdk` and
  `openaiCompatible(id)` providers.

## [1.1.4] - 2026-11-01

**Apply:** `verifyChain` has a new result, `{ valid: false, status: 'never-enabled' }`, which has no
`brokenAtRecordId`; handle it wherever you read that field. Enable `ledger.hashChain` before the
first write: records written earlier are reported as unchained and are not protected.

### Fixed

- **Enabling `ledger.hashChain` on a ledger that already has records no longer makes `verifyChain`
  report the oldest record as tampered.** `verifyChain` required every settled record to carry a
  hash, so the first record written before the chain was enabled failed verification and ended the
  walk, and the chained records after it were never checked. It now follows the chain by its links:
  records without a hash are counted in the new `unchainedCount` and reported as not protected, the
  hashed records must start at one genesis with no gap in the links, and a record whose hash was
  removed while its `prevHash` stayed is reported as broken. A ledger with settled records and no
  hashed one returns `{ valid: false, status: 'never-enabled' }`. The result type gains
  `unchainedCount` and an optional `chainStartsAtRecordId`; the new `never-enabled` variant has no
  `brokenAtRecordId`. A `from`/`to` call still checks each record's own hash only. A record that no other
  record names as its predecessor (the newest one, and a hold that settled while a later-created record
  was already hashed) can be deleted without detection, and the chain is unkeyed; both limits are in the README.

  **Apply:** code that reads `brokenAtRecordId` after `valid === false` must also handle the
  `never-enabled` variant, which has none. Enable the chain before the first write; a rise in
  `unchainedCount` after enabling is worth investigating.

### Changed

- The GitHub Release body is now the tag's own `CHANGELOG.md` section instead of the generated
  pull-request list, and the release stops before publishing when the version has no section.
  No change to the package.
- The release-notes step starts the section only at a line that begins `## [<version>]`, so a
  version token elsewhere in a heading, such as `## [Unreleased] [1.1.1]`, no longer selects the
  wrong body.
- The unused optional peer `@opentelemetry/api` is removed from `peerDependencies` and
  `peerDependenciesMeta`. The package imports nothing from it; telemetry goes through the
  `ITelemetrySink` you implement. Consumers lose only an install hint.

### Documentation

- The README says that `MODEL_PRICES_SEED` has no rows for `azure-openai`, `vertex`, `bedrock` or
  `openrouter`, so with `pricing.strict` on a call through the first three presets throws
  `AI_TOKENS_PRICE_NOT_FOUND` until the host adds a price (the `openrouter` preset rates from the
  provider-reported cost), and shows a minimal `upsertPrice` call.

## [1.1.3] - 2026-10-31

**Billing:** if you set prices with `upsertPrice` for a model the snapshot also prices while
`pricing.seedFromSnapshot` was on, a restart of an earlier version could replace them with the
snapshot. Run the two queries under the seed entry below to look for affected rows.

### Fixed

- **`forRootAsync({ useFactory })` accepts a factory with typed parameters.** The declared
  signature `(...args: unknown[]) => ...` rejected the form Nest code normally writes,
  `useFactory: (config: ConfigService) => ...`, so every consumer had to take `unknown` and cast.
  The member is now declared with method syntax, which makes its parameters bivariant, and the
  variadic form still compiles. No runtime change.

  **Apply:** no action required. A cast such as `(prisma: unknown) => ... prisma as PrismaService`
  can be replaced by a typed parameter.

- **A disabled wallet, budget or guard service no longer injects as `null` with `forRootAsync`.**
  `forRootAsync` resolves its options after the providers are declared, so it registers
  `WalletService`, `BudgetService` and `BudgetGuard` even when the options leave them out, and it
  used to inject `null`: a consumer got `TypeError: Cannot read properties of null` at its first
  call, with a type that said `WalletService`. It now injects a stand-in whose methods throw
  `AI_TOKENS_INVALID_CONFIG`; the reason names the missing options block, `wallets` or
  `budgets`. The stand-in is an instance of the service's class. `forRoot` is unchanged: it does not register a disabled service.

  **Apply:** code that tested the injected service for `null` to detect a disabled feature must
  check its own options instead.

- **`AI_TOKENS_NOT_CONFIGURED` is documented as reserved.** Nest finishes resolving the async
  options before it builds any service, so nothing raises it.

- **A restart no longer reverts prices the host set, and the snapshot seed no longer adds rows.**
  With `pricing.seedFromSnapshot` on (the default), every boot re-ran each seed row through
  `upsertPrice`, which closes the open row of that model and inserts a new one. A second boot
  against a seeded database added one closed zero-length row and one new open row per seed row
  (34 rows after two boots, 17 closed), and a rate the host had set with `upsertPrice` was
  closed before its own start date while the snapshot row became the open row again, so the
  snapshot price silently replaced the host's price on every restart. The seed now inserts
  only the model, operation and tier combinations that have no row at all, in one transaction
  under a per-combination `pg_advisory_xact_lock`, and never touches existing history. The
  session-scoped `pg_try_advisory_lock` the seed used is no longer taken: a session lock stays
  held until its connection closes, so whether a boot seeded depended on which old connections
  were still alive. `PrismaAiTokensStore.acquireSeedLock` stays for compatibility and is
  deprecated. `IPricingStore` gains the optional method `seedPrice`; a custom store without it
  is seeded from `getPriceHistory` and `upsertPrice`, which is not atomic across replicas.

  **Apply:** a 1.1.x database may hold duplicated zero-length rows and reverted overrides. Find
  them with the queries below; deleting or re-entering rows is your call, nothing here changes
  data.

  ```sql
  -- Rows the old seed closed at the instant they began (one per extra boot).
  SELECT "provider", "model", "operation", "serviceTier", COUNT(*) AS "rows"
  FROM "ai_model_prices"
  WHERE "effectiveTo" = "effectiveFrom"
  GROUP BY 1, 2, 3, 4;

  -- Rows closed before their own start: a price set with upsertPrice that a later boot reverted.
  SELECT "provider", "model", "operation", "serviceTier", "inputNanoUsdPerMillion",
         "effectiveFrom", "effectiveTo"
  FROM "ai_model_prices"
  WHERE "effectiveTo" < "effectiveFrom";
  ```

  A row from the second query is a rate you set; re-enter it with `upsertPrice` at its original
  `effectiveFrom`.

### Added

- `ChainVerification`, the result of `LedgerService.verifyChain`, is exported by name from the
  package root (a type only).

### Documentation

- **The README says how to create the tables and what the public API is.** The SQL migration and
  the Prisma schema fragment ship in the package under `dist/prisma/` but were not mentioned; the
  setup section now names both. The API reference lists the decorators (including `@AiFeature`),
  the money and ledger helpers, the catalogs, the injection tokens and `CounterValueOutOfRangeError`.
  The `budgets.defaultPolicy` Type column read `'block' | 'alert'`; the type is
  `'block' | 'throttle' | 'allow'`. The content sidecar section states that the library ships no
  `IContentStore` implementation or table, and the configuration section describes the
  `forRootAsync` and `forRoot` behaviour for a disabled wallet or budget block. The 1.0.0 entries
  that named an `OtelTelemetrySink` and a six-step resolution chain were corrected to the code.

- **The README now matches the code.** The configuration table gave the wrong default for
  `pricing.seedFromSnapshot` (`true`, not `false`), `budgets.defaultPolicy` (`'block'`, not
  `'alert'`) and `holds.ttlSeconds` (`3600`, not `300`), and gave no default for
  `wallets.creditRateNanoUsd` (`1_000_000_000n`). It told readers to pass an
  `OtelTelemetrySink` that the library does not ship; the option is `telemetry.sink`, which
  takes your own `ITelemetrySink`, next to `telemetry.metrics`. The Bedrock preset is
  `providerPresets.bedrock`, not `providerPresets.bedrockConverse`. The artifact-size table,
  the stack list (it named a `ConfigurableModuleBuilder` the module does not use) and the
  `AI_TOKENS_PRICE_NOT_FOUND` description (it counted resolution steps) were corrected too.
- **The README examples compile.** Some examples called methods or read fields that do not
  exist: `wallets.getOrCreate` (the method is `getBalance`, and it returns `nanoUsd` and
  `credits`), `metering.summarize` (it is `UsageReportService.summarize`), `reports.export`
  with a `format` property (the format is the second argument), and a markup policy typed on
  `MeteringContext` (its `resolve` takes the narrower call context).

## [1.1.2] - 2026-10-30

### Fixed

- **`PricingService.resolveRate` no longer serves one request's price to another.** The
  resolution cache key joined provider, model, baseModel, operation, tier and time bucket
  with `|`, which can also appear inside a model id. Two different requests could spell the
  same key — `model: 'b|c'` with no `baseModel` against `model: 'b'` with `baseModel: 'c|'` —
  and the second received the first's rate from the cache. The key is now a JSON array of
  the fields, so no value can move the boundary between them. (#117)

  **Apply:** no action required. Requests whose model names contain `|` now resolve their
  own price instead of a colliding entry's.

### Security

- Advisories on transitive **dev** packages are cleared through `pnpm-workspace.yaml`
  overrides: body-parser, multer, qs and zod (#115). deepmerge GHSA-gcqx-w48m-w2h4 has no
  patched release and is reached only through `jest-config`, so it is ignored in
  `osv-scanner.toml` until 2027-01-27. None of these reach a consumer install: the package
  has no runtime dependencies.

### Documentation

- `SECURITY.md`: only the latest minor line (1.1.x) receives security fixes; 1.0.x is
  unsupported and consumers should upgrade.

## [1.1.1] - 2026-10-23

### Fixed

- **A failed expired-hold scan no longer crashes the process.** `HoldReaper` read the
  expired holds outside any `try`, and its interval callback discarded the promise
  `sweep()` returned. A database error during that read — a failover or a dropped
  connection — became an unhandled rejection, which terminates Node in every process that
  loads the module. The scan is now guarded: a failure is logged once under the stable key
  `ai_tokens.hold_reaper.scan_failed` with the error's `name`, `message` and string/number
  `code` only, and the sweep ends; the next tick retries. Every timer-driven sweep also
  carries a `catch` (logged as `ai_tokens.hold_reaper.sweep_failed`), so no rejection from
  `sweep()` can escape the interval. Per-hold isolation, the multi-replica claim, `unref()`
  and shutdown are unchanged. (#108)

  **Apply to a derived backend:** a consumer that wrapped its store's `findExpiredHolds`
  in a local guard (catching the error and returning `[]`) to survive this can drop that
  guard once it runs 1.1.1. The reaper now absorbs and logs the failure itself.

### Security

- Advisories on transitive **dev** packages are cleared through `pnpm-workspace.yaml`
  overrides: handlebars, proxy-addr, multer, undici, @grpc/grpc-js, fast-uri, js-yaml and
  brace-expansion (#109); fast-uri and qs (#87); browserslist and mysql2 (#85);
  deepmerge-ts (#80). osv-scanner reports no issues on the lockfile. None of these reach a
  consumer install: the package has no runtime dependencies.

### Changed

- The budget counter-key construction moved to its own module, and its injectivity is
  now asserted in tests: the keys are built from a caller-supplied `budgetId` and a
  caller-chosen timestamp, and the specs fail if a field is reordered or a delimiter
  changes. `COUNTER_DIMENSIONS` is the single runtime list the dimension type derives
  from. No exported type or value changed. (#91)
- Dev dependencies and CI actions updated (#79, #83, #111, and the pinned-action bumps). The
  mutation gate now runs every spec rather than only Jest's related tests, which had silently
  dropped specs reaching the code through helpers under `test/` (#112).
- Published artifact: every `.d.ts` is byte-identical to 1.1.0, and so are the `shared`,
  `prisma`, `redis` and `prices` bundles. Only the `server` bundle changed, from 38,204 to
  38,417 B brotli, inside its 40,000 B budget.

## [1.1.0] - 2026-08-11

### Changed

- **BREAKING: `ioredis` peer moved to `^6.0.0`** (was `^5.0.0`; the ranges are disjoint, so an
  ioredis 5 consumer no longer satisfies the contract). It aligns the `./redis` budget counter
  with `@bymax-one/nest-queue@1.2.0`, so a backend that consumes both resolves one shared `ioredis`.
  ioredis 6 defaults to RESP3 but keeps `replyMapping: "legacy"`, leaving reply shapes unchanged at
  runtime; the store's URL-only `new Redis(url)` construction is untouched by the RESP3 options
  typing break, so no source changed.
- **Mutation gate raised to a perfect score.** `stryker.config.json` now breaks below 100 (`break`,
  `high` and `low` are all 100), so no surviving mutant can pass the gate.

## [1.0.4] - 2026-08-10

Remediation of a local audit's settlement findings (merged in #65). No API changes.

### Fixed

- **Negative usage can no longer credit the wallet or budget.** `clampUsageCounts` floors every
  token count — and the provider-reported cost (`providerReportedCostNanoUsd`) — at zero before the
  signed settlement leg. A normalizer that computes a field by subtraction (OpenRouter's
  `prompt - cached`), or a provider that reports a negative `usage.cost`, would otherwise credit
  back more than was reserved and drive budget consumption negative.
- **Streaming captures are clamped like non-stream captures.** `finalizeCaptureUsage` now routes
  the `StreamUsageCollector` final through `normalizeCaptureUsage`, so a provider-final stream
  carrying negative counts or cost no longer bypasses the floor and reaches settlement raw.

### Documentation

- `RecordInput.occurredAt` documents its trust model: it is a deliberate backfill feature, honoured
  as given because `record()`'s input is trusted host input, and a host that forwards a value an
  untrusted end user controls must validate it first — a back-dated timestamp selects a historical
  price and an earlier budget window.

## [1.0.3] - 2026-08-06

### Fixed

- **Every suppression reason was dropped from the mutation report.** All 249 `// Stryker
disable` directives in the source wrote their justification after `--`. Stryker reads a
  directive with one regular expression, `/^\s?Stryker (disable|restore)(?: (next-line))?
([a-zA-Z, ]+)(?::(.+)?)?/`, whose mutator list accepts letters, commas and spaces only
  and which captures the reason exclusively after a colon. A `-` therefore closed the
  mutator list and left the reason unmatched, so each directive still silenced its mutant
  but the report recorded Stryker's fallback text, `Ignored using a comment`. The README
  claimed the opposite — that every suppression carries its reason — and documented the
  broken separator as the convention. The directives now use `<Mutator>: <reason>`, which
  is the grammar the parser accepts, and the reasons reach the report.

### Added

- `check:mutants` gate (`scripts/check-mutation-directives.mjs`) — validates every
  `// Stryker` comment against the parser's own regular expression, rejecting a reason
  written after `--`, a reason wrapped onto a second comment line (the report keeps only
  the first fragment), and a mutator name Stryker does not know, which would silence
  nothing at all. Wired into CI and `prepublishOnly`. Stryker warns about the last case,
  but only during a mutation run, which on this repo happens post-merge.

### Changed

- No runtime behaviour changed. `dist/` differs only in the text of those comments; the
  server bundle moved from 38,096 to 38,145 B brotli, well inside its 40,000 B budget.

## [1.0.2] - 2026-08-05

### Fixed

- **The module could not be initialised by a consumer at all.** `MeteringInterceptor` is
  registered as a plain class provider, so Nest resolves its constructor — but only the
  third parameter carried a token. Nest reads two separate metadata keys for this:
  `self:paramtypes`, written by `@Inject()`, and `design:paramtypes`, written by
  TypeScript. The published bundle is built by tsup/esbuild, and esbuild states it cannot
  implement `emitDecoratorMetadata` because it does not replicate TypeScript's type
  system — so the second key was never there. The first two parameters had neither, and
  the container threw `Nest can't resolve dependencies of the MeteringInterceptor
(?, +, Symbol(BYMAX_AI_TOKENS_OPTIONS))` before any provider was created. Both now
  carry `@Inject`.

### Changed

- `emitDecoratorMetadata` is `false` in `tsconfig.json`. It was `true`, which was never
  true of the artifact: tsup prints `You have emitDecoratorMetadata enabled but
@swc/core was not installed, skipping swc plugin` on every build, and that warning had
  been printed on every build of this package. Turning it off makes the source compile
  the way the bundle is built, so a parameter that depends on reflected types now fails
  where it is cheap to see.
- The imports that existed only to feed that metadata are `import type` again. The lint
  rule reported each one the moment the flag went off, which makes it a precise detector
  for this defect: an import that is value-only because a constructor parameter needs its
  type is an import that will not survive the bundle.

## [1.0.1] - 2026-08-04

### Removed

- The README's `Migration` section, which described migrating an AI cost layer out of a
  named private monorepo. It reached the npm page of a public package, where it named a
  repository its readers cannot see and cannot act on. The normative rule it carried —
  translate `0`/`null` limits to no budget row — is already stated under the budget
  semantics and is unchanged.

### Security

- The Redis credentials are no longer disclosed when `RedisBudgetCounterStore` is
  serialized. The store kept the live client — or the connection URL it is opened from —
  in a TypeScript `private` property, which is erased at runtime and leaves an enumerable
  own property. A connection URL carries the password inline and an ioredis instance
  carries `options.password` as a plain field, so `JSON.stringify`, object spread and
  `util.inspect` emitted the password in plaintext, which is what a structured logger does
  when it renders its arguments and what an error reporter does when it captures the scope
  of a throw. The source and the in-flight lazy connection both move to ECMAScript private
  fields.

Reading on purpose is unchanged and no public type or export moved.

## [1.0.0] - 2026-08-03

First published release. Everything below ships in it.

The `Fixed` and `Security` entries record defects found and corrected before
publication, not regressions any consumer saw — there is no earlier release to
have regressed from. They are kept because the reasoning is worth having.

### Added

- **Nine provider normalizers** — OpenAI Chat Completions, OpenAI Responses API, OpenAI-compatible (DeepSeek, xAI, Groq, Azure OpenAI), Anthropic Messages, Google Gemini / Vertex AI, AWS Bedrock Converse, Mistral, OpenRouter, Vercel AI SDK v5/v6. All are pure functions over plain objects; no provider SDK peer dependency.
- **Versioned effective-dated pricing** — `PricingService` with a model-resolution chain (exact, `baseModel`, alias map, normalized id, longest prefix), in-memory TTL cache, `upsertPrice()`, and idempotent `MODEL_PRICES_SEED` snapshot seed. Rates are bigint nano-USD per million tokens; past records are never re-rated.
- **Immutable append-only ledger** — `LedgerService` with content-derived idempotency (`deriveIdempotencyKey`), exactly-once semantics (payload-hash replay detection), lifecycle transitions (pending → posted → reversed/released), filtered queries, and optional per-tenant tamper-evident hash chain (`verifyChain()`).
- **First-class markup / margin** — `MarkupResolver` with a fixed multiplier or a per-call `IMarkupPolicy`. Every record stores both `rawCostNanoUsd` (provider cost) and `billedCostNanoUsd` (after markup). The resale lever is a first-class configuration option, not application code.
- **Prepaid wallets** — `WalletService` with grant/debit/refund/adjust entries, configurable burn order (expiry/priority/FIFO), overdraft support, and debit-allocation tracking.
- **Multi-dimension budgets** — `BudgetService` with per-scope, per-feature, per-window (daily/weekly/monthly/total) caps on spend, token count, and operation count. Hard block (`policy: 'block'`) or soft alert with threshold events. Renewal-anchored windows via `anchorAt`.
- **Optional Redis budget counter** — `RedisBudgetCounterStore` with a single atomic Lua `incrIfBelow` script for sub-ms cross-replica enforcement.
- **Full hold → capture lifecycle** — `MeteringService.hold()` / `capture()` / `release()` / `meter()` for pre-flight spend reservation. `capture()` is idempotent.
- **Streaming capture** — `StreamUsageCollector` accumulates SSE chunks, prefers provider-final usage, falls back to tokenizer on abort.
- **NestJS enforcement** — `BudgetGuard` (CanActivate), `MeteringInterceptor` (NestInterceptor), and the `@Meter`, `@RequireBudget`, `@AiFeature` decorators for declarative controller-level metering.
- **Usage reporting** — `UsageReportService` with SQL-aggregated `summarize()`, CSV/JSON `export()`, paginated history, per-model analytics, and currency conversion.
- **Events** — Typed domain events (`ai_tokens.*`) delivered to `@nestjs/event-emitter` (optional peer) and/or an `IEventSink` port.
- **OpenTelemetry** — The `ITelemetrySink` port, which you implement over `@opentelemetry/api` (optional peer); the library ships no sink and imports nothing from `@opentelemetry/api`.
- **PostgreSQL adapter** — `PrismaAiTokensStore` (`./prisma` subpath) implementing all four storage ports via parameterized raw SQL. Seven-table schema with migrations.
- **Five subpaths** — `.` (server), `./shared` (zero-dep), `./prices` (data-only), `./prisma` (adapter), `./redis` (counter).
- **Zero runtime dependencies** — `"dependencies": {}`. All runtime functionality via peer dependencies.
- **100% unit test coverage** — 804 tests; 10-scenario Testcontainers e2e suite; Stryker mutation gate at 100.00% (0 surviving mutants, break 95).

- **Prisma 7 support, alongside Prisma 6.** The declared peer range has always
  been `>=6.0.0`, but nothing verified the claim; the end-to-end suite now runs
  against Prisma 7 and a real PostgreSQL, and it is what surfaced the conflict
  defect above. The library's own code needed no change — it reaches PostgreSQL
  exclusively through parameterized raw SQL, and every `Prisma.*` helper it uses
  is unchanged across the two majors.

  What changed is the development schema and the test harness, mirroring what a
  host application has to do: `url` left the `datasource` block for a new
  `prisma.config.ts`, and clients are opened through `@prisma/adapter-pg` rather
  than the removed `datasourceUrl`. Both setups are documented in the README.

- **`pnpm check:exports`** runs `attw --pack . --profile strict` against the packed
  tarball, which is what surfaced both resolution defects above.
- **`pnpm check:runtime`** packs the tarball, lays it out the way npm would, and
  asserts in ESM _and_ CommonJS that an error thrown by `PrismaAiTokensStore`
  satisfies `instanceof AiTokensException` against the class the root exports. No
  source-based suite can observe this: the unit tests map the subpath specifiers to
  `src` and therefore see a single copy. Both gates run in CI.

### Fixed

- **Idempotency conflicts were reported as generic store errors under Prisma 7.**
  A raw-query unique violation carries the native SQLSTATE, and where it carries
  it depends on how the client reaches the database. Prisma 6 puts it flat on
  `meta.code`; a Prisma 7 driver adapter nests the driver's own error under
  `meta.driverAdapterError.cause`. `isUniqueViolation` read only the first, so on
  Prisma 7 the exactly-once replay-or-conflict path (§15.2) degraded a 409
  `AI_TOKENS_IDEMPOTENCY_CONFLICT` into a 500-class `AI_TOKENS_STORE_ERROR` —
  silently, since nothing threw. Both shapes are now read.

- **Errors thrown by `PrismaAiTokensStore` were not recognised as
  `AiTokensException`.** The store lives in the `./prisma` entry point and reached
  the class through a relative path into `../server`, so the separate bundle got
  its own copy. The copy carries the same name and the same shape, so nothing
  crashed — but the four `instanceof AiTokensException` guards in
  `bymax-ai-tokens.module.ts`, `hold-support.ts`, `wallet.service.ts` and
  `metering.service.ts` all stopped matching, silently reclassifying store errors
  such as `AI_TOKENS_INSUFFICIENT_CREDITS` and `AI_TOKENS_IDEMPOTENCY_CONFLICT` as
  unexpected failures.

  `./prisma` now imports the class by package specifier, which the bundler already
  kept external for the lazily-loaded `./prices` subpath, so one identity is shared
  in CommonJS as well as ESM. `isLedgerIdempotencyConflict` was unaffected: it is
  deliberately duck-typed rather than `instanceof`-based.

- **CommonJS consumers resolved ESM type declarations** on all five subpaths. The
  `exports` map declared a single `types` condition, so `require()` landed on
  `.d.ts` instead of `.d.cts`. Types are now declared per condition.

- **`node10` type resolution failed outright**: the manifest carried no `main`,
  `module` or `types`, and no `typesVersions`. All four are now present.

### Security

- **Peer floors raised to exclude known-vulnerable NestJS versions.** The declared
  ranges were `@nestjs/common ^11.0.0` and `@nestjs/core ^11.0.0`, and both
  admitted versions carrying published advisories:

  | Peer             | Advisory                                                                                                                                    | Vulnerable                    | New floor  |
  | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- | ---------- |
  | `@nestjs/common` | [GHSA-cj7v-w2c7-cp7c](https://github.com/advisories/GHSA-cj7v-w2c7-cp7c) — remote code execution via the `Content-Type` header              | `>= 11.0.0-next.1, < 11.0.16` | `^11.0.16` |
  | `@nestjs/core`   | [GHSA-36xv-jgw5-4q75](https://github.com/advisories/GHSA-36xv-jgw5-4q75) — improper neutralization of special elements in downstream output | `<= 11.1.17`                  | `^11.1.18` |

  A peer range is a statement about which versions this library supports. A floor
  below a published advisory tells a consumer that a vulnerable install is a
  supported one, and nothing in their tooling contradicts it — the install resolves
  cleanly and silently. Corrected before the first publish, so no released version
  ever carried the permissive range. No runtime behaviour changed.

---

[1.0.0]: https://github.com/bymaxone/nest-ai-tokens/releases/tag/v1.0.0
[1.0.1]: https://github.com/bymaxone/nest-ai-tokens/compare/v1.0.0...v1.0.1
[1.0.2]: https://github.com/bymaxone/nest-ai-tokens/compare/v1.0.1...v1.0.2
[1.1.0]: https://github.com/bymaxone/nest-ai-tokens/compare/v1.0.4...v1.1.0
[1.1.2]: https://github.com/bymaxone/nest-ai-tokens/compare/v1.1.1...v1.1.2
[1.1.3]: https://github.com/bymaxone/nest-ai-tokens/compare/v1.1.2...v1.1.3
[1.1.4]: https://github.com/bymaxone/nest-ai-tokens/compare/v1.1.3...v1.1.4
[1.1.5]: https://github.com/bymaxone/nest-ai-tokens/compare/v1.1.4...v1.1.5
[1.1.6]: https://github.com/bymaxone/nest-ai-tokens/compare/v1.1.5...v1.1.6
[1.1.7]: https://github.com/bymaxone/nest-ai-tokens/compare/v1.1.6...v1.1.7
[1.1.8]: https://github.com/bymaxone/nest-ai-tokens/compare/v1.1.7...v1.1.8
[1.1.9]: https://github.com/bymaxone/nest-ai-tokens/compare/v1.1.8...v1.1.9
[1.1.10]: https://github.com/bymaxone/nest-ai-tokens/compare/v1.1.9...v1.1.10
[1.1.11]: https://github.com/bymaxone/nest-ai-tokens/compare/v1.1.10...v1.1.11
[1.1.12]: https://github.com/bymaxone/nest-ai-tokens/compare/v1.1.11...v1.1.12
[1.1.1]: https://github.com/bymaxone/nest-ai-tokens/compare/v1.1.0...v1.1.1
[1.0.4]: https://github.com/bymaxone/nest-ai-tokens/compare/v1.0.3...v1.0.4
[1.0.3]: https://github.com/bymaxone/nest-ai-tokens/compare/v1.0.2...v1.0.3
[1.1.13]: https://github.com/bymaxone/nest-ai-tokens/compare/v1.1.12...v1.1.13
[1.1.14]: https://github.com/bymaxone/nest-ai-tokens/compare/v1.1.13...v1.1.14
[1.1.15]: https://github.com/bymaxone/nest-ai-tokens/compare/v1.1.14...v1.1.15
[1.1.16]: https://github.com/bymaxone/nest-ai-tokens/compare/v1.1.15...v1.1.16
[1.1.17]: https://github.com/bymaxone/nest-ai-tokens/compare/v1.1.16...v1.1.17
[1.1.18]: https://github.com/bymaxone/nest-ai-tokens/compare/v1.1.17...v1.1.18
[1.1.19]: https://github.com/bymaxone/nest-ai-tokens/compare/v1.1.18...v1.1.19
[1.1.20]: https://github.com/bymaxone/nest-ai-tokens/compare/v1.1.19...v1.1.20
[1.1.21]: https://github.com/bymaxone/nest-ai-tokens/compare/v1.1.20...v1.1.21
[1.1.22]: https://github.com/bymaxone/nest-ai-tokens/compare/v1.1.21...v1.1.22
[1.1.23]: https://github.com/bymaxone/nest-ai-tokens/compare/v1.1.22...v1.1.23
[1.1.24]: https://github.com/bymaxone/nest-ai-tokens/compare/v1.1.23...v1.1.24
[1.1.25]: https://github.com/bymaxone/nest-ai-tokens/compare/v1.1.24...v1.1.25
[1.1.26]: https://github.com/bymaxone/nest-ai-tokens/compare/v1.1.25...v1.1.26
[Unreleased]: https://github.com/bymaxone/nest-ai-tokens/compare/v1.1.26...HEAD
