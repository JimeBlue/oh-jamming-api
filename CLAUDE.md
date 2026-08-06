# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev      # watch mode, loads .env.development.local
npm run build    # rm -rf dist && tsc
npm start        # NODE_ENV=production node dist/app.js
```

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
- **`updateXSchema`** — `xInputSchema.partial()`, refined to reject an empty body (`at least one field is required`).
- **`xOutputSchema`** — shapes the response: adds `id`, omits secrets, reuses field rules via `.shape`.

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

`req.user` is typed by the global augmentation in `src/types/express.d.ts`, which also owns the `AuthPayload` type — `utils/jwt.ts` imports it from there rather than redeclaring it.

### Data model decisions

`README.md` lists the three collections; the models themselves are the source of truth for fields. What isn't visible in either, and must not be reinvented:

- **JamSessions** (not yet built) — `instrumentTemplate: [{ instrument, spotsTotal }]` is what the venue's form sets. At creation it is expanded into the embedded `slots[].spots[]` array of individually labelled, individually bookable spots (`{ spotId, instrument, label, bookingId }`), with `bookingId` null while a spot is free. Availability is per spot, not a counter.
- **Bookings** (not yet built) — **one document per claimed spot.** A band claiming several spots in one submission produces several documents sharing a `groupId`; the UI regroups by `groupId`. Cancelling sets `status: "cancelled"` and frees the spot — bookings are never hard-deleted.

Two invariants the implementation must preserve:

- **Claiming a spot is a single atomic `findOneAndUpdate`** matching on `bookingId: null` with `arrayFilters`, never read-then-check-then-write. A `null` result means the spot was taken concurrently → `409`. The `Booking` document is only created after the claim succeeds. Multi-spot submissions run the claim once per spot, each succeeding or failing independently.
- **Role checks live server-side** on every protected route (a `requireRole(role)` middleware returning `403`), not only in the frontend.

## Deployment (Render, free tier)

Live at `https://oh-jamming-api.onrender.com`; the Next.js client is a separate repo and separate Render web service.

- Build `npm install && npm run build`, start `npm start`. Env vars: `MONGODB_URI`, `CLIENT_URL`, `JWT_SECRET`. Do not set `PORT` — Render injects it.
- `NODE_ENV` is **not** a Render env var: the `start` script sets `NODE_ENV=production` itself. That single word is what switches the cookies to `sameSite: 'none'` + `secure`, so if the start command is ever changed it has to be preserved or auth silently fails cross-site.
