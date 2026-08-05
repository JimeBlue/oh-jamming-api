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
PORT = 8080
MONGODB_URI = your mongo connection string
```

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
└── app.ts         app entry point
```

## Data model

Three collections:

- **Users** — venue or musician (one role per account)
- **JamSessions** — session details, with embedded time slots and individually bookable spots
- **Bookings** — one document per claimed spot; a band booking shares one `groupId`
