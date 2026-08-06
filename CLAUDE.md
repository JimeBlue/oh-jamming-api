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
- **`#*` subpath imports** are declared in `package.json` and mirrored in `tsconfig.json` `paths`. `#models/User.ts` resolves to `./src/models/User.ts` under the `development` condition and `./dist/models/User.js` otherwise. `npm run dev` passes `--conditions development` to select the first branch; `npm start` gets the `default`. Note that `app.ts` currently uses a plain relative import instead — either style works.
- `verbatimModuleSyntax` is on, so type-only imports must be written as `import type { ... }`.

Strictness is high: `strict`, plus `noUncheckedIndexedAccess` (indexing an array yields `T | undefined`) and `noImplicitOverride`.

## Architecture

`src/app.ts` is the entry point and does everything inline — no separate server/app split. It awaits `connectDB()` at the top level *before* `app.listen()`, so the process will not serve traffic without a working Mongo connection.

`src/db/index.ts` sets a **global** `mongoose.set('toJSON', ...)` transform: every model serializes with a virtual `id` and no `_id`. Do not re-declare that per schema.

CORS is an explicit origin allowlist built from `process.env.CLIENT_URL` plus `http://localhost:3000`, with `credentials: true`. A wildcard origin is incompatible with credentials by spec, so the allowlist must stay explicit for the auth cookies to work.

### Data model 

Three collections, per the project's design docs:

- **Users** — `firstName`, `lastName`, `email`, `passwordHash`, `role: "venue" | "musician"` (exactly one role per account), `instrumentsPlayed` (musicians only).
- **JamSessions** — owned by a venue. `instrumentTemplate: [{ instrument, spotsTotal }]` is what the venue's form sets; at creation it is expanded into the embedded `slots[].spots[]` array of individually labelled, individually bookable spots (`{ spotId, instrument, label, bookingId }`). `bookingId` is `null` while the spot is free.
- **Bookings** — **one document per claimed spot**. A band claiming several spots in one submission produces several documents sharing a `groupId`; the UI regroups by `groupId`. Cancelling sets `status: "cancelled"` and frees the spot — bookings are never hard-deleted.

Two invariants the implementation must preserve:

- **Claiming a spot is a single atomic `findOneAndUpdate`** matching on `bookingId: null` with `arrayFilters`, never read-then-check-then-write. A `null` result means the spot was taken concurrently → `409`. The `Booking` document is only created after the claim succeeds. Multi-spot submissions run the claim once per spot, each succeeding or failing independently.
- **Role checks live server-side** on every protected route (a `requireRole(role)` middleware returning `403`), not only in the frontend.

## Deployment (Render, free tier)

Live at `https://oh-jamming-api.onrender.com`; the Next.js client is a separate repo and separate Render web service.

- Build `npm install && npm run build`, start `npm start`. Env vars: `MONGODB_URI`, `CLIENT_URL`. Do not set `PORT` — Render injects it.

