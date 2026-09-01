# Oh Jamming — API

Backend for **Oh Jamming**, a web app for booking a spot in a jam session.

Venues post jam sessions with time slots and the instruments they need. Musicians browse
sessions and book individual instrument spots — solo or as a band in one submission.

## Tech stack

| | |
| --- | --- |
| **Runtime** | Node.js, Express 5, TypeScript |
| **Database** | MongoDB via Mongoose |
| **Validation** | Zod — every body, query and param |
| **Auth** | JSON Web Tokens in httpOnly cookies, bcrypt for passwords |
| **Images** | Cloudinary, uploaded through the API rather than from the browser |
| **AI** | Google Gemini — listing copy, and natural-language browse |
| **Hardening** | helmet, CORS with credentials, four separate rate limiters |
| **Hosting** | Render |

## Getting started

```bash
npm install
cp .env.example .env.development.local
npm run dev
```

Two variables have no default and the server refuses to boot without them:

| Variable | |
| --- | --- |
| `MONGODB_URI` | Mongo connection string |
| `JWT_SECRET` | 64 chars or more — `openssl rand -hex 64` |

`PORT` (8080), `REFRESH_TOKEN_TTL` (30 days, in seconds) and `CLIENT_URL` all have defaults and can
be left out locally — `http://localhost:3000` is already allowed by CORS. `CLIENT_URL` is
comma-separated, because the client can be served from more than one origin at once, and
`VERCEL_PREVIEW_PREFIX` lets that project's preview deployments through as well: each preview gets
its own hostname, so they cannot be listed in advance.

The four remaining variables are **optional on purpose**:

| Variable | Without it |
| --- | --- |
| `CLOUDINARY_CLOUD_NAME` / `_API_KEY` / `_API_SECRET` | `POST /uploads/image` answers `503`; everything else works |
| `GEMINI_API_KEY` | `POST /ai/*` answers `503`; everything else works |

Requiring them would mean a deploy that forgot one refuses to boot — the whole app down for a
feature nobody was using. Everything else is validated at import time, so a missing or malformed
value stops the process at startup rather than surfacing as an `undefined` at the first login.

## Scripts

| Script          | Description                             |
| --------------- | --------------------------------------- |
| `npm run dev`   | Start the dev server with file watching |
| `npm run build` | Compile TypeScript to `dist/`           |
| `npm start`     | Run the compiled server                 |
| `npm run seed`  | Reset the demo data                     |

## Demo data

`npm run seed` fills the database with 4 venues, 8 musicians and 44 jam sessions — 20 recurring
nights, each repeating the way a real one does — plus a set of existing bookings, including a slot
with every spot taken, a partly booked slot, a band booking sharing one `groupId`, and a cancelled
booking. Every account uses the password `demopassword`; log in as `jane@ohjamming.demo` for the
fullest "My bookings", or `ana@ohjamming.demo` to see the venue side.

Session dates are generated relative to the day you run it, so the seeded nights are always
upcoming. It is safe to re-run — that is the point, since developing against the booking flow fills
the board up quickly.

**It only ever removes what it created.** Demo accounts are identified by their `@ohjamming.demo`
email address, and the cleanup deletes those users, their jam sessions and the bookings on them —
nothing else, and no collection is ever cleared. It also refuses to run when `NODE_ENV=production`.

## Project structure

```
src/
├── controllers/   route handlers
├── db/            database connection
├── middleware/    error handling, validation, auth
├── models/        Mongoose schemas
├── routes/        Express routers
├── schemas/       Zod validation schemas
├── scripts/       the demo seed
├── types/         Express request augmentation
├── utils/         tokens, cookies, sessions
├── config.ts      validated environment variables
└── app.ts         app entry point
```

## API

| Method   | Route                      | Access                           |
| -------- | -------------------------- | -------------------------------- |
| `POST`   | `/users`                   | public — this is registration    |
| `GET`    | `/users/:id`               | own account only                 |
| `PATCH`  | `/users/:id`               | own account only                 |
| `DELETE` | `/users/:id`               | own account only                 |
| `POST`   | `/auth/login`              | public                           |
| `POST`   | `/auth/refresh`            | refresh cookie                   |
| `DELETE` | `/auth/logout`             | public (idempotent)              |
| `GET`    | `/auth/me`                 | authenticated                    |
| `GET`    | `/jam-sessions`            | public                           |
| `GET`    | `/jam-sessions/:id`        | public                           |
| `POST`   | `/jam-sessions`            | venues only                      |
| `PATCH`  | `/jam-sessions/:id`        | owning venue only                |
| `DELETE` | `/jam-sessions/:id`        | owning venue only — cancels      |
| `GET`    | `/bookings`                | authenticated — scoped by role   |
| `GET`    | `/bookings/:id`            | owning musician or venue         |
| `POST`   | `/bookings`                | musicians only                   |
| `DELETE` | `/bookings/:id`            | owning musician — cancels        |
| `DELETE` | `/bookings/group/:groupId` | owning musician — cancels a band |
| `POST`   | `/uploads/image`           | venues only — multipart          |
| `POST`   | `/ai/overview`             | venues only                      |
| `POST`   | `/ai/summary`              | venues only                      |
| `POST`   | `/ai/search`               | public                           |
| `GET`    | `/health`                  | public — status and db state     |

Browsing is public: a visitor can see what's on before deciding to register. Posting and
editing are venue-only, enforced server-side.

### Browse filters

`GET /jam-sessions` accepts `genre`, `skillLevel`, `status`, `venueId`, `city`, `from`, `to`,
`page` and `limit`. Unknown parameters are rejected with a `400` rather than ignored, so a typo
can't silently return everything.

By default the list shows **active sessions from today onwards**, soonest first. Pass `from`
to reach further back, or `status=cancelled` to see cancelled ones.

`city` is matched as a case-insensitive substring of the address line rather than a field of its
own — there is no city on the model — so it finds "Berlin" in `Torstraße 1, 10119 Berlin` and
equally in a street called Berliner Allee. That imprecision is the deal: a real city field means
changing the address shape, the client's geocoding step and every session already stored.

A session tagged `all-genres` matches *every* genre filter, and `all-levels` matches every
skill level — otherwise a venue that welcomed everyone would be found by nobody.

### Paging

**The response is an object, not an array.** One page plus what a pager needs:

```json
{ "items": [ … ], "total": 44, "page": 1, "limit": 12 }
```

12 per page by default, `limit` capped at 48 — without a cap, `?limit=999999` is the unpaginated
query with extra steps, every session on the platform serialised with its whole `slots` array from
an endpoint nobody has to log in to reach. `?limit=1000` is a `400` rather than a silent clamp,
which would answer with 48 items and no indication it had ignored the question.

`page` is 1-based, and a page past the end is an empty `items` with a real `total` rather than a
`404` — nothing is missing, the caller just walked off the end, and `total` is what puts them back
on a page that exists.

The sort is by date, then `_id` as a tiebreaker. That is not cosmetic: without a unique final key,
Mongo may order two sessions on the same date differently between the `skip(0)` query and the
`skip(12)` one, which is how the same session appears on page 1 and again on page 2 while another
appears on neither.

## Rate limits

Four separate limiters, each on the thing it protects. The numbers below are production; local
development gets roughly ten times as much, so the limiter can be exercised without getting in the
way.

| Routes | Limit |
| --- | --- |
| `POST /auth/login`, `POST /users` | 10 per 15 minutes |
| `POST /ai/overview`, `POST /ai/summary` | 20 per hour, shared |
| `POST /ai/search` | 30 per hour |
| `POST /uploads/image` | 30 per hour |

They answer `429` with the same `{ message }` shape as every other error, so a client renders them
without a special case.

The two AI writers share one bucket, which is the honest arrangement: the quota they spend is one
quota, so a venue that generates ten summaries has ten fewer overviews to spend. On the venue-only
routes the limiter runs **before** `authenticate`, so a client stuck in a retry loop is refused
before its token is read, and an anonymous or musician request costs nothing from a quota shared by
every venue on the platform.

## Images

`POST /uploads/image` takes multipart with a single image field, and answers `201 { url }` with a
`res.cloudinary.com` URL — which is all the client ever stores. 5MB, images only, venues only.

It is a separate endpoint rather than a multipart branch of `POST /jam-sessions`, and that is the
decision it rests on: a session's body is nested — an address object, two arrays of objects, numbers
with cross-field rules — and multipart flattens all of it to strings, so accepting the file on the
create route would mean the client JSON-encoding four fields and the schema decoding them back.
This route has exactly one job: bytes in, URL out.

Both guards run before the stream is parsed, so a request from the wrong kind of account is refused
without the file ever being read off the socket.

## AI

Gemini, called from the server only — the key never reaches a browser. All three routes are
optional infrastructure: without `GEMINI_API_KEY` they answer `503` and the rest of the API is
unaffected.

- **`POST /ai/overview`** and **`POST /ai/summary`** take `{ notes }` — a venue's rough notes, 1000
  characters — and return a draft to edit, delete or ignore. Nothing is created and nothing is
  stored; the session is still made by the same single `POST /jam-sessions` at the end. What comes
  back is validated against the jam session's *own* length rules, so copy that would be rejected at
  the end of the wizard is caught while the venue can still do something about it.

- **`POST /ai/search`** takes `{ query }`, one sentence, and returns
  `{ understood, explanation, ignored, filters }`. It touches no data: `filters` is what to pass to
  `GET /jam-sessions`, which the client then calls itself, so there is exactly one place that knows
  how the browse is filtered and sorted. Public, like the browse it feeds — a search box that
  demands an account is a search box nobody uses.

  `understood: false` is the off-topic gate. "What's the weather" returns no filters, and without
  the flag that is indistinguishable from "no filters matched" — which renders as every session on
  the platform. `ignored` names the parts of the sentence no filter can express (an instrument, a
  price), because without it the search quietly answers a different question than the one asked.

  A filter the model returns malformed becomes no filter rather than an error: the browse runs
  slightly wider than asked instead of not at all. Repeats of a phrase already read today are served
  from a cache, so they cost no quota.

## Authentication

Two `httpOnly` cookies, so no token is ever readable by JavaScript on the client:

- **`accessToken`** — a signed JWT carrying `{ userId, role }`, valid 15 minutes.
- **`refreshToken`** — an opaque random string. Only its SHA-256 hash is stored, in the
  `refreshtokens` collection.

`POST /users` and `POST /auth/login` both issue the pair, so registering logs you straight in.

When an access token expires, the API answers `401` with a `WWW-Authenticate: token_expired`
header. That is the client's cue to call `POST /auth/refresh` and retry, rather than logging the
user out. Refresh **rotates**: the old token is marked revoked and a new pair is issued. If a
revoked token is ever presented again, every session for that user is destroyed — a replayed
token means someone has a copy.

Logging out deletes the refresh token and clears both cookies. The access token itself stays valid
until it expires — a signed JWT cannot be revoked — so a copy captured before logout would still
work for up to 15 minutes. That short lifetime is the mitigation.

Roles are enforced server-side with `requireRole('venue')` / `requireRole('musician')`, never only
in the client. `role` is fixed at registration and cannot be changed through `PATCH /users/:id`.

**There is no `GET /users`, and `/users/:id` is your own account only.** Accounts are not browsable:
an index route would hand any logged-in caller every email address on the platform, and nothing in
the app needs one. What a venue is allowed to know about a musician who booked its night comes from
`GET /bookings` — a name and an email, so it can reach the people turning up. The booking is what
grants that: there is no route anywhere that resolves a stranger's name into an account.

## Jam sessions

A venue describes its night once — a date, a time window, a slot length and a line-up:

```json
{
  "date": "2026-09-16",
  "startTime": "19:00",
  "endTime": "22:00",
  "slotDurationMinutes": 60,
  "instrumentTemplate": [
    { "instrument": "Lead Guitar", "spotsTotal": 3 },
    { "instrument": "Drums", "spotsTotal": 1 }
  ]
}
```

The server expands that into the slots musicians actually book. Three one-hour slots, each with
four individually claimable spots:

```
19:00–20:00   First Lead Guitar · Second Lead Guitar · Third Lead Guitar · Drums
20:00–21:00   First Lead Guitar · Second Lead Guitar · Third Lead Guitar · Drums
21:00–22:00   First Lead Guitar · Second Lead Guitar · Third Lead Guitar · Drums
```

Availability is per spot — `bookingId: null` means free. There is no counter to fall out of step.

Rules worth knowing before using the API:

- **Times are wall-clock in Europe/Berlin.** `date` is a calendar day, `startTime` and `endTime`
  are `"HH:mm"`. A session cannot cross midnight or start in the past.
- **The window must divide evenly.** 19:00–21:30 in 45-minute slots leaves a 15-minute stub and is
  rejected rather than silently truncated.
- **Slots are never accepted from a client.** Nor is `venueId` — it comes from the access token —
  nor `status`. Sending any of them is a `400`.
- **Once any spot is booked, the shape is frozen.** `date`, `startTime`, `endTime`,
  `slotDurationMinutes` and `instrumentTemplate` can no longer change (`409`); the title, summary,
  overview, genres and skill levels still can.
- **Sessions are cancelled, never deleted.** `DELETE` sets `status: "cancelled"` and cancels every
  confirmed booking on the session with it, so nobody is left holding a receipt for a night that
  isn't happening. Cancelling twice is not an error.
- **A venue cannot delete its account while it has upcoming sessions** — it has to take them off
  the board first, so musicians see a cancellation rather than a session that quietly disappears.
- `address.formatted` is required; `lat`/`lng` are optional but must come as a pair. They exist only
  to draw a map pin, so a venue missing from the geocoder can still post by typing the address.

## Bookings

A musician picks one time slot and claims one or more spots inside it. Solo or as a band, that is
a single request:

```json
{
  "jamSessionId": "68f2...",
  "slotId": "0f0c1e5a-...",
  "spotIds": ["a1b2...", "c3d4...", "e5f6..."],
  "bandName": "The Nightowls"
}
```

The response is **one booking document per spot**, all sharing a `groupId` and a `qrCode`. That is
what lets a band cancel one instrument without touching the rest, while "My bookings" still draws
the whole thing as a single card and the band presents one code at the door.

Each booking also carries the spot's `instrument`, `label`, `slotStartTime` and `slotEndTime`,
copied at the moment it was claimed — so a booking renders on its own, without fetching the session
and walking its slots.

Rules worth knowing before using the API:

- **A spot is claimed atomically.** Two musicians submitting the same spot at the same instant get
  one `201` and one `409`; there is no window in which both succeed. The `409` names the instrument
  and time so the client can say which one to re-pick.
- **A submission is all-or-nothing.** If any spot in a multi-spot request has just been taken, the
  ones already claimed are released and nothing is written. A band gets all five spots or none.
- **Bookings are cancelled, never deleted.** `DELETE` sets `status: "cancelled"` and frees the spot
  for someone else. Cancelling twice is not an error, and cancelled bookings stay in every list —
  they are the musician's history and the venue's record of who dropped out.
- **There is no edit endpoint.** Dropping one instrument is cancelling that booking; moving to
  another slot is cancel and rebook, because a spot can only ever be acquired through the claim.
  When moving, book the new slot *first* — cancelling first can leave you with nothing if the new
  spots turn out to be taken.
- **Cancelling a jam session cancels its bookings** (see above), so a musician never sees
  "confirmed" against a night that was called off.
- **Nothing here is public.** A musician sees their own bookings, and a venue sees the bookings on
  its own sessions — name and email of the musician, and nothing else. The projection *is* the
  rule: whatever it doesn't select never leaves the database, so no careless render can leak it.
  The email is there because a venue cancelling a night at short notice otherwise has no way to
  tell the people who signed up for it. What that doesn't grant is a directory — see
  [Authentication](#authentication): there is no route anywhere that turns a name into an account,
  and the filter here composes with the ownership scope rather than replacing it, so it cannot be
  pointed at another venue's roster.
- `qrCode` is an opaque token, not an image. The client renders the QR code from it.

## Data model

Three collections:

- **Users** — venue or musician (one role per account)
- **JamSessions** — session details, with embedded time slots and individually bookable spots
- **Bookings** — one document per claimed spot; a band booking shares one `groupId`
