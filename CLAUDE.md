# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev      # watch mode, loads .env.development.local
npm run build    # rm -rf dist && tsc
npm start        # NODE_ENV=production node dist/app.js
npm run seed     # reset the demo data (src/scripts/seed.ts)
```

**`npm run seed` points at whatever `MONGODB_URI` says, and that is the same database the deployed app uses.** Three things follow, and none of them are optional if the script is ever edited: it refuses to run when `NODE_ENV=production`; demo accounts are tagged by an `@ohjamming.demo` email address and the cleanup only ever deletes those users, their jam sessions and the bookings on them; and no collection is ever cleared wholesale. Session dates are generated relative to the run date rather than hardcoded, so re-running always produces upcoming nights. Users are created one at a time with `User.create` rather than `insertMany`, because `insertMany` skips document middleware and would store the passwords unhashed — the accounts would exist and no login would work. Sessions go through `jamSessionInputSchema` and `generateSlots`, and bookings through `claimSpot`, so seeded state is indistinguishable from state the API produced.

There is no test runner and no linter configured in this repo. Type checking happens through `npm run build`.

`.env.development.local` is required for `npm run dev` and is gitignored — see `.env.example` for the keys. Only `MONGODB_URI` and `JWT_SECRET` are mandatory; `PORT`, `CLIENT_URL` and `REFRESH_TOKEN_TTL` have defaults.

**Environment variables are read in one place: `src/config.ts`.** It parses `process.env` through a Zod schema at import time and calls `process.exit(1)` on a bad value, so a missing secret is a boot failure rather than a runtime surprise. Never reach for `process.env` elsewhere — import from `#config` instead. `isProduction` is exported from there too and is what drives the cookie flags and the rate limit.

## TypeScript execution model

Node runs the TypeScript sources directly via native type stripping. There is no tsx, ts-node, or nodemon. Three consequences:

- **Relative imports must carry the explicit `.ts` extension** (`import connectDB from './db/index.ts'`). `allowImportingTsExtensions` permits it and `rewriteRelativeImportExtensions` turns it into `.js` at build time.
- **`#*` subpath imports** are declared in `package.json` and mirrored in `tsconfig.json` `paths`. `#models/User` resolves to `./src/models/User.ts` under the `development` condition and `./dist/models/User.js` otherwise. `npm run dev` passes `--conditions development` to select the first branch; `npm start` gets the `default`. Convention: `app.ts` uses relative imports, everything under `src/` uses `#` aliases.
  - **`#x/y` must map to a real file at `src/x/y.ts`** — node's subpath imports do no `index.ts` fallback, so `#config` needs `src/config.ts`, not `src/config/index.ts`. TypeScript's `paths` *does* resolve the directory form, so `npm run build` passing is not proof the app boots. Verify a new `#` import by running, not by compiling.
- `verbatimModuleSyntax` is on, so type-only imports must be written as `import type { ... }`.

Strictness is high: `strict`, plus `noUncheckedIndexedAccess` (indexing an array yields `T | undefined`) and `noImplicitOverride`.

## Architecture

`src/app.ts` is the entry point and does everything inline — no separate server/app split. It awaits `connectDB()` at the top level *before* `app.listen()`, so the process will not serve traffic without a working Mongo connection.

`src/db/index.ts` sets a **global** `mongoose.set('toJSON', ...)` transform: every model serializes with a virtual `id` and no `_id`. Do not re-declare that per schema.

CORS is an explicit origin allowlist built from `CLIENT_URL` plus `http://localhost:3000`, with `credentials: true`. A wildcard origin is incompatible with credentials by spec, so the allowlist must stay explicit for the auth cookies to work. `exposedHeaders: ['WWW-Authenticate']` is also required — without it the browser hides that header from client JS, and the client can't tell an expired access token from a dead session.

`app.set('trust proxy', 1)` is not optional in production. Render terminates TLS at its proxy and forwards over plain http, so without it Express considers every request insecure (refusing `secure` cookies) and sees the proxy's IP for every client (collapsing the rate limiter into one shared bucket).

There is no service layer. A request flows: **route → `authenticate` → `requireRole`/`requireSelf` → `validateParams`/`validateBody` (Zod) → controller → model**, and any error thrown along the way lands in `errorHandler`.

Mounting order in `app.ts` matters and must be preserved: `trust proxy`, `helmet`, `cors`, `express.json`, `cookieParser`, routes, `notFoundHandler`, `errorHandler`, then `connectDB()`, then `listen()`. `cookieParser` before the routes is what populates `req.cookies` for `authenticate`.

### File naming

One resource per file, named consistently across the layers:

| Layer | File | Export |
|---|---|---|
| Model | `models/User.ts` | default `model('User', UserSchema)` |
| Zod schemas | `schemas/userSchema.ts` | named exports |
| Controllers | `controllers/users.ts` | named exports, one per handler |
| Routes | `routes/userRoutes.ts` | default `Router()` |
| Middleware | `middleware/validateBody.ts` | default export, camelCase |
| Utilities | `utils/jwt.ts` | named exports |

## Conventions

### Models

Plain `new Schema({ ... }, { timestamps: true })` — no generics, no separate TS interface. Validation messages use the array form: `required: [true, 'firstName is required']`, `minLength: [2, 'min length is 2 chars']`.

Two rules learned from the `User` model:

- **`pre('save')` hooks run BEFORE mongoose validation, not after.** Mongoose's middleware wraps `Model.prototype.save`, and validation runs inside the wrapped body. So a `minLength` on a field a hook rewrites (e.g. a password being hashed) would only ever measure the rewritten value. Put that check in Zod instead.
- **Secrets get `select: false`.** `User.password` is excluded from every query result unless a query asks with `.select('+password')`. Note this filters *query results only* — a document you just created still holds the value in memory, which is why responses also go through an output schema.

### Validation

Zod owns request validation; mongoose validators are the DB-layer safety net, and both express the same rule. **Zod runs first**, so any normalisation the client should benefit from (trimming, coercion) must live in the Zod schema — a `trim: true` in the model never sees a value Zod already rejected.

Each `schemas/xSchema.ts` exports three schemas plus inferred types:

- **`xInputSchema`** — `z.strictObject`, so unknown keys are a 400 rather than silently dropped.
- **`updateXSchema`** — `xInputSchema.partial()`, refined to reject an empty body (`at least one field is required`). **Updates are `PATCH`, never `PUT`** — the schema is `.partial()`, so the request is a partial modification. `PUT` promises replacement, which would mean an omitted field should be cleared; these endpoints leave it alone. New resources follow this.
- **`xOutputSchema`** — shapes the response: adds `id`, omits secrets, reuses field rules via `.shape`.

**Output schemas must use plain `z.object`, never `z.strictObject`, for nested shapes.** They parse
mongoose *documents*, and an embedded subdocument carries its entire prototype — `_doc`,
`$__parent`, `save`, `toObject` and about eighty more. A strictObject reports every one of them as
an unrecognized key and refuses the parse. Share the field rules via `.shape` instead of reusing the
input schema itself. Strictness belongs on the way in, where an unexpected key means the client sent
something wrong; on the way out it would only mean mongoose is mongoose.

`validateQuery` is the third member of the family, and it cannot follow the pattern of the other
two. **Express 5 exposes `req.query` through a getter with no setter** (it parses the query string
lazily), so `req.query = data` throws `Cannot set property query of #<IncomingMessage> which has
only a getter`. It uses `Object.defineProperty` instead. `req.body` and `req.params` are ordinary
properties and assign fine. Controllers type the parsed result through the fourth `RequestHandler`
generic: `RequestHandler<Params, ResBody, ReqBody, ReqQuery>`.

Cross-field rules use `.superRefine()` with an explicit `path` so the issue attaches to the right field. A refined schema no longer exposes `.shape` or `.partial()`, so keep the raw fields in a private base object (`userFields`) and build all three exports from it.

Two consequences of Zod running first that are easy to get wrong:

- **Anything used as a lookup key must be normalised in Zod, not the model.** `emailField` lowercases and trims, because the model's `lowercase: true` only applies on save — a login querying `findOne({ email })` with different casing would silently match nothing. Fields shared between schemas (like `emailField`, used by both `userSchema` and `authSchema`) are exported individually rather than duplicated.
- **A `.partial()` update schema cannot enforce cross-field rules**, because the sibling field is usually absent from the body. `updateUserSchema` therefore drops `instrumentsMatchRole` and lets the mongoose validator catch it — on `save()` the path is modified and `this` is the stored document, which does know the role. That produces the same message and the same 400.

**`role` is omitted from `updateUserSchema` on purpose.** It is set once at registration and never edited: allowing it would be privilege escalation, would orphan the JamSessions and Bookings that reference a user by role, and would leave the 15-minute access token disagreeing with the database. Because the base is a `strictObject`, sending it returns `400 Unrecognized key: "role"` rather than being ignored.

### Controllers

No try/catch — errors are thrown and formatted centrally. Throw with a status on the cause:

```ts
throw new Error('User not found', { cause: { status: 404 } });
```

Handlers are typed `RequestHandler<Params, ResBody, ReqBody>`, with DTOs derived from the Zod schemas rather than hand-written:

```ts
type UserInputDTO = z.input<typeof userInputSchema>;
type UserOutputDTO = z.infer<typeof userOutputSchema>;
```

Every response goes through `xOutputSchema.parse()`. This is what guarantees secrets never ship, since `select: false` doesn't cover freshly created documents.

Uniqueness is checked at the app layer for a friendly `409` (`User.findOne({ email })`), with the unique index as the actual guarantee — `errorHandler` maps the `E11000` race to the same `409`.

**Updates must use `findById` + `set` + `save()`, never `findByIdAndUpdate`.** That method bypasses document middleware, so the `pre('save')` hook never fires (a new password would be stored in plaintext) and document validators are skipped — and even with `runValidators: true`, `this` is the query rather than the document, so cross-field validators can't read sibling values.

### Error handling

`errorHandler` resolves the status in this order:

| Condition | Status |
|---|---|
| `err.cause.status` (errors we throw) | as given |
| `err.status` (e.g. body-parser's `SyntaxError`) | as given |
| mongoose `ValidationError` | 400, field messages joined |
| mongoose `CastError` | 400 |
| `err.code === 11000` | 409, field read from `err.keyValue` |
| anything else | 500, message replaced with `Internal server error` |

Only the final branch hides the message — everything above it was written for the client. The full stack is logged to the console in dev only.

### Auth

Cookie-based, not `Authorization: Bearer`. Two `httpOnly` cookies, so no token is reachable from client JS and an XSS bug cannot steal a session.

| Cookie | Contents | Lifetime |
|---|---|---|
| `accessToken` | signed JWT, payload `{ userId, role }` | 15 min |
| `refreshToken` | opaque `randomUUID`, SHA-256 hash stored in `RefreshToken` | 30 days |

Rules that hold the design together:

- **`POST /users` is registration.** There is no `/auth/register`; `/auth` holds only `login`, `refresh`, `logout`, `me`. All three login paths call the same `issueSession()` in `utils/session.ts`, so they cannot drift apart.
- **The refresh token is hashed with SHA-256, not bcrypt** — the opposite of `User.password`. It is 122 bits of random, so there is nothing to brute-force, and the lookup has to be deterministic. A salted hash would make `findOne({ tokenHash })` impossible.
- **Refresh rotates and detects reuse.** The old row is marked `revokedAt` rather than deleted, because a deleted row is indistinguishable from a token that never existed. A revoked token presented again means someone holds a copy, so every session for that user is deleted.
- **Expiry is checked explicitly** even though a TTL index exists — mongo's sweep only runs about once a minute.
- **An expired access token gets `WWW-Authenticate: token_expired`** alongside the 401. That header is the client's contract: refresh and retry rather than logging the user out. A bad signature gets a plain 401 with no hint.
- **Login asks for the password explicitly** (`.select('+password')` — the only place in the app that does) and answers unknown-email and wrong-password with the same generic 401, so the endpoint can't be used to enumerate accounts. It deliberately does **not** apply the registration password rules; that would leak the policy and lock out older accounts.
- **Logout does not invalidate the access token, and cannot.** It deletes the refresh token and tells the browser to drop both cookies, but a signed JWT stays valid until it expires — a copy captured beforehand still works for up to 15 minutes. This is accepted, not overlooked: the alternative is a denylist lookup on every request, which throws away the reason to use JWTs at all. The short TTL is the mitigation. Deleting an account is the same story, which is why `deleteUser` also clears the cookies and the user's `RefreshToken` rows.
- **Cookie flags come from `isProduction`.** Production gets `sameSite: 'none'` + `secure: true`, which is mandatory rather than a preference: `onrender.com` is on the Public Suffix List, so the client and API count as cross-site and any `lax`/`strict` cookie is silently dropped between them. Locally it is `lax` and non-secure, since there is no HTTPS. `clearAuthCookies` must reuse the same options — a browser only overwrites a cookie when name, path and domain match.

Three guards, composed in this order:

- `authenticate` — verifies the cookie, sets `req.user`. 401 on failure.
- `requireRole('venue')` — "what kind of user is this?" 403 on failure. Always after `authenticate`, which is what makes an anonymous request a 401 rather than a 403.
- `requireSelf` — "is this *their* record?" Compares `req.user.userId` to `req.params.id`. Ownership is a different question from role: every musician may edit a musician account, but only their own.

On `/users/:id`, `authenticate` runs *before* `validateParams` so an anonymous caller learns nothing about the id they sent.

**There is no `GET /users`, and `requireSelf` guards `GET /users/:id` as well as the writes.** Accounts are not browsable. An index route existed once and was removed: it returned every user through `userOutputSchema`, which includes `email`, to any authenticated caller — so registering as a musician got you every account on the platform. Nothing needs it, because a venue learns who booked its night from `GET /bookings`, where BK18 gives it a name and an email for the musicians who booked *that venue's* session — contact details earned by a booking, never by a lookup. Do not add one back without a narrower output schema; `userOutputSchema` carries `email` precisely because it is only ever used on the caller's own account.

`req.user` is typed by the global augmentation in `src/types/express.d.ts`, which also owns the `AuthPayload` type — `utils/jwt.ts` imports it from there rather than redeclaring it.

### Time

**Every wall-clock value is interpreted in one fixed zone, `APP_TIMEZONE` in `utils/time.ts`
(Europe/Berlin).** This is a decision, not a default: jam sessions happen in physical rooms in one
city, so `"19:00"` means 19:00 there regardless of where the reader is. Storing UTC instants would
be more portable but would drag a conversion into every comparison and form field.

Consequences that hold the design together:

- **`date` is a calendar day pinned to midnight UTC; times are `"HH:mm"` strings.** All time
  arithmetic goes through `timeToMinutes`/`minutesToTime`, which is what keeps DST out of the
  picture — a 19:00–22:00 session is three hours of wall clock on every date of the year.
- **ISO dates and `"HH:mm"` times sort correctly as strings**, so "is this in the past?" is a plain
  `<` against `nowInAppTimezone()`, with nothing to convert and nothing to get subtly wrong.
- **`new Date('2026-02-30')` does not produce an Invalid Date** — it silently rolls over to March 2.
  Calendar validity comes from `z.iso.date()`, which does real range checking. Never hand-roll it.
- Zod carries `date` as a `"YYYY-MM-DD"` string all the way to the controller, which converts it
  with `dateStringToUtcMidnight` on the way to the model. `utcMidnightToDateString` is the inverse,
  needed when an update has to be re-validated against the stored document.

### Data model decisions

`README.md` lists the three collections; the models themselves are the source of truth for fields.
What isn't visible in either, and must not be reinvented:

- **JamSessions** — `instrumentTemplate: [{ instrument, spotsTotal }]` is what the venue's form
  sets. At creation `generateSlots` expands it into the embedded `slots[].spots[]` array of
  individually labelled, individually bookable spots (`{ spotId, instrument, label, bookingId }`),
  with `bookingId` null while a spot is free. **Availability is per spot, not a counter** — a
  counter would be a second source of truth to keep in step under concurrency, which is the whole
  bug the atomic claim exists to avoid.
- **Bookings** — **one document per claimed spot.** A band claiming several spots in one submission produces several documents sharing a `groupId` and a `qrCode`; the UI regroups by `groupId`. Cancelling sets `status: "cancelled"` and frees the spot — bookings are never hard-deleted.

Two invariants the implementation must preserve:

- **Claiming a spot is a single atomic `findOneAndUpdate`** matching on `bookingId: null` with `arrayFilters`, never read-then-check-then-write. A `null` result means the spot was taken concurrently → `409`. The `Booking` document is only created after the claim succeeds. A multi-spot submission is all-or-nothing: the first refusal releases everything already claimed (BK07).
- **Role checks live server-side** on every protected route (a `requireRole(role)` middleware returning `403`), not only in the frontend.

### Jam sessions

The rules are numbered JS01–JS15 on the project board; the code comments cite those numbers. The
ones that shape the implementation rather than just validating a field:

- **Reading is public, writing is venue-only.** On `/jam-sessions/:id`, `validateParams` runs
  *before* `authenticate` — the opposite of `/users/:id`. There is no identity to protect on a
  public GET, so a malformed id is just a malformed id.
- **Ownership (JS02) is checked inside the controller, not in middleware**, via
  `findOwnedJamSession`. `requireSelf` can be middleware because the answer is already in the URL;
  ownership of a *resource* isn't, so a middleware version would load the same document twice to
  answer one question. The 404 deliberately precedes the 403: the browse is public, so existence is
  not a secret.
- **Two field lists govern updates, and they are not the same list.** `FROZEN_ONCE_BOOKED` includes
  `date`; `RESHAPES_SLOTS` doesn't, because slots carry times, not dates — moving a session to
  another day leaves its 19:00 slot at 19:00. `date` is frozen anyway: someone who booked a Tuesday
  did not agree to a Friday.
- **A partial update cannot be checked against the cross-field rules**, so when a shape field
  changes the update is merged over the stored document and the whole thing re-run through
  `jamSessionInputSchema`. This runs *only* when a shape field changed — re-validating a title edit
  would re-run the past-date rule and reject a typo fix on a session happening tonight.
- **The catch-all tags match every filter** (JS15): `?genre=jazz` matches `all-genres` sessions too,
  via `$in: [genre, ALL_GENRES]`. Exact matching would make a venue that welcomed everyone findable
  by nobody.
- **`venueId` is never populated.** The venue's public identity — `venueName`, `address` — lives on
  the session, because a promoter may run nights in several rooms and the User model has no venue
  name at all. So the browse never touches the users collection and cannot leak an email.
- **`deleteUser` blocks on *upcoming* active sessions only.** A session is never marked
  "completed" — its status stays `active` after the night has passed — so counting every active
  session would permanently lock out any venue that had ever used the app.
- **The generation caps are enforced twice**: in Zod, for a 400 that explains the arithmetic, and
  again inside `generateSlots`, which throws a bare `Error` (so, a 500) for callers that skipped
  validation — a seed script or a migration. `slots[].spots[]` is embedded, so an unbounded template
  is a way to write a multi-megabyte document against Mongo's 16MB ceiling.

### Bookings

Numbered BK01–BK18 on the project board, same convention as JS. **Five are deliberately deferred
and their numbers are reserved, not reused**: BK05 (unknown spot folded into the same `409` as a
taken one), BK09 (`bandName` required only for a group — it is plain optional), BK13 (no block on
cancelling after the slot has started), BK15 (no update endpoint at all), BK16 (a musician *can*
delete their account while holding bookings; the equivalent venue rule still applies). Do not
"finish" these without being asked — they were cut against a deadline, not overlooked.

`utils/claimSpot.ts` is the only genuinely concurrent code in the app, and both functions in it
share one non-obvious rule:

- **The deciding condition goes in the query filter, not only in `arrayFilters`.** This is the trap:
  `arrayFilters` alone still matches the *document* by `_id`, updates zero array elements, and hands
  back a document that is indistinguishable from a successful claim. The nested `$elemMatch` on
  `slots` is what makes "nothing to claim" arrive as `null`.
- **Never decide anything from `modifiedCount`.** `JamSession` has `timestamps: true`, so mongoose
  appends `$set: { updatedAt }` to every update — the document counts as modified whenever it
  matches by `_id`, whether or not any spot was touched. `releaseSpot` originally used it and
  cheerfully reported success on spots it had not freed.
- **`releaseSpot` matches on our own `bookingId`**, not on "not null", so it can only ever free a
  spot this booking holds. That is what makes it safe to call from a rollback, a retry and a
  double-clicked cancel alike.
- The booking `_id` is **generated before the claim** (`new Types.ObjectId()`), because the claim has
  to write something into `bookingId` and the document does not exist yet. It is then used as the
  document's `_id`, so spot and booking point at each other from the first moment either exists.

The rest of what shapes the implementation:

- **`groupId` and `qrCode` have no `default` on the model, on purpose.** A mongoose default fires
  per document, which would give every spot in one submission its own group and its own QR code —
  exactly backwards. The controller generates one of each per submission.
- **A partial unique index on `spotId where status: 'confirmed'`** is the database-level backstop
  behind the atomic claim. Partial is load-bearing: a spot that is claimed, cancelled and reclaimed
  accumulates cancelled rows, and a plain unique index would make the second musician ever to book
  it collide with the first one's cancelled record.
- **Claims run sequentially, not in parallel.** Capped at ten spots, so a submission that will fail
  stops at the first refusal instead of acquiring the rest only to hand them back.
- **Cancelling writes the document first, then frees the spot.** The two writes cannot be one
  operation. Release-first would leave a musician holding a "confirmed" receipt for a spot someone
  else can take; cancel-first leaves one spot unsold. The second is the quieter failure.
- **`insertMany` failure also releases.** Otherwise the spots stay held forever with nothing
  recording why.
- **The denormalized display fields (`instrument`, `label`, `slotStartTime`, `slotEndTime`) are a
  snapshot, not a cache.** They are safe because JS10 freezes the session's times and line-up as
  soon as any spot is booked, so they cannot drift while the booking is live.
- **`bookingSchema.ts` exports two schemas, not the usual three** — there is no `updateBookingSchema`
  because BK15 is deferred. It also owns `groupIdParamSchema`, since a `groupId` is a uuid and
  `idParamSchema` would reject every valid one.
- **`bookingDetailOutputSchema` renames while it parses.** `.populate()` replaces the value at the
  same path, so a populated session arrives under the key `jamSessionId`; a `.transform()` emits it
  as `jamSession` and `musicianId` as `musician`. BK18 is the populate *projection* — the musician
  arrives as a name and an email and nothing else, so what the schema declares is all there ever was
  to declare.
- **`authenticate` is mounted on the whole booking router**, unlike the other two. Nothing here is
  public, so there is no route it can be omitted from by accident.
- **`GET /bookings` is one endpoint for both roles** — a musician's own bookings, a venue's sessions'
  bookings. Splitting it would make the client pick a URL based on its own role. It takes no query
  parameters at all; the client splits upcoming from past.
- **The BK14 cascade runs outside `cancelJamSession`'s idempotence check**, so a repeat call repairs
  a cascade that failed halfway. The spots keep their `bookingId`s: a dead session is not
  availability.

## Deployment (Render, free tier)

Live at `https://oh-jamming-api.onrender.com`; the Next.js client is a separate repo and separate Render web service.

- Build `npm install && npm run build`, start `npm start`. Env vars: `MONGODB_URI`, `CLIENT_URL`, `JWT_SECRET`. Do not set `PORT` — Render injects it.
- `NODE_ENV` is **not** a Render env var: the `start` script sets `NODE_ENV=production` itself. That single word is what switches the cookies to `sameSite: 'none'` + `secure`, so if the start command is ever changed it has to be preserved or auth silently fails cross-site.
