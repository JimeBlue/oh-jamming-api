# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev      # watch mode, loads .env.development.local
npm run build    # rm -rf dist && tsc
npm start        # NODE_ENV=production node dist/app.js
```

There is no test runner and no linter configured in this repo. Type checking happens through `npm run build`.

`.env.development.local` is required for `npm run dev` and is gitignored — see `.env.example` for the keys (`PORT`, `MONGODB_URI`, `CLIENT_URL`).

## TypeScript execution model

Node runs the TypeScript sources directly via native type stripping. There is no tsx, ts-node, or nodemon. Three consequences:

- **Relative imports must carry the explicit `.ts` extension** (`import connectDB from './db/index.ts'`). `allowImportingTsExtensions` permits it and `rewriteRelativeImportExtensions` turns it into `.js` at build time.
- **`#*` subpath imports** are declared in `package.json` and mirrored in `tsconfig.json` `paths`. `#models/User` resolves to `./src/models/User.ts` under the `development` condition and `./dist/models/User.js` otherwise. `npm run dev` passes `--conditions development` to select the first branch; `npm start` gets the `default`. Convention: `app.ts` uses relative imports, everything under `src/` uses `#` aliases.
- `verbatimModuleSyntax` is on, so type-only imports must be written as `import type { ... }`.

Strictness is high: `strict`, plus `noUncheckedIndexedAccess` (indexing an array yields `T | undefined`) and `noImplicitOverride`.

## Architecture

`src/app.ts` is the entry point and does everything inline — no separate server/app split. It awaits `connectDB()` at the top level *before* `app.listen()`, so the process will not serve traffic without a working Mongo connection.

`src/db/index.ts` sets a **global** `mongoose.set('toJSON', ...)` transform: every model serializes with a virtual `id` and no `_id`. Do not re-declare that per schema.

CORS is an explicit origin allowlist built from `process.env.CLIENT_URL` plus `http://localhost:3000`, with `credentials: true`. A wildcard origin is incompatible with credentials by spec, so the allowlist must stay explicit for the auth cookies to work.

There is no service layer. A request flows: **route → `validateParams`/`validateBody` (Zod) → controller → model**, and any error thrown along the way lands in `errorHandler`.

Mounting order in `app.ts` matters and must be preserved: routes, then `notFoundHandler`, then `errorHandler`, then `connectDB()`, then `listen()`.

### File naming

One resource per file, named consistently across the layers:

| Layer | File | Export |
|---|---|---|
| Model | `models/User.ts` | default `model('User', UserSchema)` |
| Zod schemas | `schemas/userSchema.ts` | named exports |
| Controllers | `controllers/users.ts` | named exports, one per handler |
| Routes | `routes/userRoutes.ts` | default `Router()` |
| Middleware | `middleware/validateBody.ts` | default export, camelCase |

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

### Data model decisions

`README.md` lists the three collections; the models themselves are the source of truth for fields. What isn't visible in either, and must not be reinvented:

- **JamSessions** (not yet built) — `instrumentTemplate: [{ instrument, spotsTotal }]` is what the venue's form sets. At creation it is expanded into the embedded `slots[].spots[]` array of individually labelled, individually bookable spots (`{ spotId, instrument, label, bookingId }`), with `bookingId` null while a spot is free. Availability is per spot, not a counter.
- **Bookings** (not yet built) — **one document per claimed spot.** A band claiming several spots in one submission produces several documents sharing a `groupId`; the UI regroups by `groupId`. Cancelling sets `status: "cancelled"` and frees the spot — bookings are never hard-deleted.

Two invariants the implementation must preserve:

- **Claiming a spot is a single atomic `findOneAndUpdate`** matching on `bookingId: null` with `arrayFilters`, never read-then-check-then-write. A `null` result means the spot was taken concurrently → `409`. The `Booking` document is only created after the claim succeeds. Multi-spot submissions run the claim once per spot, each succeeding or failing independently.
- **Role checks live server-side** on every protected route (a `requireRole(role)` middleware returning `403`), not only in the frontend.

## Deployment (Render, free tier)

Live at `https://oh-jamming-api.onrender.com`; the Next.js client is a separate repo and separate Render web service.

- Build `npm install && npm run build`, start `npm start`. Env vars: `MONGODB_URI`, `CLIENT_URL`. Do not set `PORT` — Render injects it.
