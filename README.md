# Oh Jamming — API

Backend for **Oh Jamming**, a web app for booking a spot in a jam session.

Venues post jam sessions with time slots and the instruments they need. Musicians browse
sessions and book individual instrument spots — solo or as a band in one submission.

## Tech stack

- Node.js + Express
- TypeScript
- MongoDB (Mongoose)
- Zod (validation)

## Getting started

```bash
npm install
```

Create a `.env.development.local` file based on `.env.example`:

```
MONGODB_URI = your mongo connection string
JWT_SECRET = generate with: openssl rand -hex 64
```

`PORT` (8080), `REFRESH_TOKEN_TTL` (30 days, in seconds) and `CLIENT_URL` all have defaults and
can be left out locally — `http://localhost:3000` is already allowed by CORS. The server validates
these at startup and refuses to boot if any are missing or malformed.

Run the dev server:

```bash
npm run dev
```

## Scripts

| Script          | Description                            |
| --------------- | -------------------------------------- |
| `npm run dev`   | Start the dev server with file watching |
| `npm run build` | Compile TypeScript to `dist/`           |
| `npm start`     | Run the compiled server                 |

## Project structure

```
src/
├── controllers/   route handlers
├── db/            database connection
├── middleware/    error handling, validation, auth
├── models/        Mongoose schemas
├── routes/        Express routers
├── schemas/       Zod validation schemas
├── types/         Express request augmentation
├── utils/         tokens, cookies, sessions
├── config.ts      validated environment variables
└── app.ts         app entry point
```

## API

| Method   | Route                      | Access                           |
| -------- | -------------------------- | -------------------------------- |
| `POST`   | `/users`                   | public — this is registration    |
| `GET`    | `/users`                   | authenticated                    |
| `GET`    | `/users/:id`               | authenticated                    |
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

Browsing is public: a visitor can see what's on before deciding to register. Posting and
editing are venue-only, enforced server-side.

### Browse filters

`GET /jam-sessions` accepts `genre`, `skillLevel`, `status`, `venueId`, `from` and `to`.
Unknown parameters are rejected with a `400` rather than ignored, so a typo can't silently
return everything.

By default the list shows **active sessions from today onwards**, soonest first. Pass `from`
to reach further back, or `status=cancelled` to see cancelled ones.

A session tagged `all-genres` matches *every* genre filter, and `all-levels` matches every
skill level — otherwise a venue that welcomed everyone would be found by nobody.

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
- **Nothing here is public.** A musician sees their own bookings, a venue sees the bookings on its
  own sessions, and a venue only ever sees a musician's name — never their email.
- `qrCode` is an opaque token, not an image. The client renders the QR code from it.

## Data model

Three collections:

- **Users** — venue or musician (one role per account)
- **JamSessions** — session details, with embedded time slots and individually bookable spots
- **Bookings** — one document per claimed spot; a band booking shares one `groupId`
