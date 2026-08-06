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

| Method   | Route         | Access            |
| -------- | ------------- | ----------------- |
| `POST`   | `/users`      | public — this is registration |
| `GET`    | `/users`      | authenticated     |
| `GET`    | `/users/:id`  | authenticated     |
| `PUT`    | `/users/:id`  | own account only  |
| `DELETE` | `/users/:id`  | own account only  |
| `POST`   | `/auth/login` | public            |
| `POST`   | `/auth/refresh` | refresh cookie  |
| `DELETE` | `/auth/logout`  | public (idempotent) |
| `GET`    | `/auth/me`    | authenticated     |

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

Roles are enforced server-side with `requireRole('venue')` / `requireRole('musician')`, never only
in the client. `role` is fixed at registration and cannot be changed through `PUT /users/:id`.

## Data model

Three collections:

- **Users** — venue or musician (one role per account)
- **JamSessions** — session details, with embedded time slots and individually bookable spots
- **Bookings** — one document per claimed spot; a band booking shares one `groupId`
