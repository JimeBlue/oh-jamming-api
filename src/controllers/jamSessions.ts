import type { RequestHandler } from 'express';
import { z } from 'zod';
import Booking from '#models/Booking';
import JamSession from '#models/JamSession';
import User from '#models/User';
import type { IdParams } from '#schemas/idParamSchema';
import {
  ALL_GENRES,
  ALL_LEVELS,
  type JamSessionQuery,
  type UpdateJamSessionInput,
  jamSessionInputSchema,
  jamSessionOutputSchema,
} from '#schemas/jamSessionSchema';
import { generateSlots } from '#utils/slots';
import { dateStringToUtcMidnight, nowInAppTimezone, utcMidnightToDateString } from '#utils/time';

// `z.infer` rather than `z.input`: by the time a controller runs, validateBody has already replaced
// req.body with the parsed result, so what arrives here is the schema's output — trimmed strings
// and all. (For these fields the two types are identical, since nothing has a default or a
// transform, but the distinction is worth getting right before one of them grows a `.default()`.)
type JamSessionInputDTO = z.infer<typeof jamSessionInputSchema>;

type JamSessionOutputDTO = z.infer<typeof jamSessionOutputSchema>;

// Nothing here populates `venueId`. The venue's public identity — its name and address — lives on
// the session itself, because a promoter may run nights in several rooms and the User model has no
// venue name on it at all. Two things fall out of that: the browse never touches the users
// collection, and a musician reading a session can never be shown a venue's email address.

// Hand-written rather than `RegExp.escape`, which exists on this Node but needs the ES2025 lib to
// be visible to tsc — a tsconfig change is a lot to spend on one line.
const escapeRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const getJamSessions: RequestHandler<
  unknown,
  JamSessionOutputDTO[],
  unknown,
  JamSessionQuery
> = async (req, res) => {
  const { genre, skillLevel, status, venueId, city, from, to } = req.query;

  // JS13 — the browse answers "what can I still turn up to?", so it starts at today unless the
  // caller asks for a range explicitly. That is how a venue reviews the nights it has already run.
  const dateFilter: { $gte: Date; $lte?: Date } = {
    $gte: dateStringToUtcMidnight(from ?? nowInAppTimezone().date),
  };

  if (to) dateFilter.$lte = dateStringToUtcMidnight(to);

  const filter: Record<string, unknown> = {
    // JS12 — cancelled sessions are reachable, but never by accident
    status: status ?? 'active',
    date: dateFilter,
  };

  // A session tagged "all-genres" welcomes a jazz player, so it belongs in the results for
  // ?genre=jazz. Matching the exact tag alone would make the catch-all invisible to every filter,
  // which is the opposite of what choosing it means — a venue that opens its night to everyone
  // would be found by nobody.
  if (genre) filter.genres = { $in: [genre, ALL_GENRES] };
  if (skillLevel) filter.skillLevel = { $in: [skillLevel, ALL_LEVELS] };
  if (venueId) filter.venueId = venueId;

  // Escaped before it becomes a pattern. Everything else here is an enum or an ObjectId; this is the
  // one filter that takes free text from the query string, and handing that to `new RegExp`
  // unescaped is either a 500 on a stray bracket or a request that never returns on a crafted one.
  if (city) filter['address.formatted'] = new RegExp(escapeRegex(city), 'i');

  // soonest first, and within a day the earlier start first — `startTime` is "HH:mm", which sorts
  // lexicographically in the same order it sorts chronologically
  const jamSessions = await JamSession.find(filter).sort({ date: 1, startTime: 1 });

  res.json(jamSessions.map((jamSession) => jamSessionOutputSchema.parse(jamSession)));
};

/* "Königstraße 93, 90402 Nürnberg" -> "Nürnberg".
 *
 * A heuristic over free text, and it has to be, because there is no city on the model — the address
 * is one `formatted` line, which is what the browse's `?city=` matches a substring of. This is the
 * same limitation seen from the other end: the filter can match a city it cannot name, so naming
 * them means reading them back out of the line.
 *
 * The postcode is the anchor. Every address the geocoder returns puts the city immediately after a
 * four- or five-digit postcode in its own comma-separated part, and a trailing country part may or
 * may not follow — so this looks for that part rather than counting from either end, which would
 * pick "Germany" off half of them.
 *
 * Null when nothing matches, and the caller drops it. An address typed by hand that this can't read
 * is one missing option in a dropdown; guessing at it would be a wrong option in a dropdown, which
 * is worse — it filters to nothing and looks like there are no sessions rather than like a bad
 * parse.
 */
const cityFromAddress = (formatted: string): string | null => {
  for (const part of formatted.split(',')) {
    const match = /^\s*\d{4,5}\s+(.+?)\s*$/.exec(part);

    if (match?.[1]) return match[1];
  }

  return null;
};

/* The cities the browse's city filter can actually find something in.
 *
 * Its own endpoint because the alternative is circular: a dropdown built from the sessions
 * currently on screen loses every other city the moment one is chosen, so choosing Berlin makes
 * Leipzig unselectable. The list has to come from outside whatever is being filtered.
 *
 * Scoped to active sessions from today onwards, matching the browse's own defaults (JS12/JS13),
 * because a city with nothing coming up is an option that can only disappoint — every entry here is
 * a filter that returns at least one night.
 *
 * `distinct` rather than an aggregation: the parsing above is a regex per address and Mongo is a bad
 * place to keep a regex nobody can read, while the number of distinct addresses is the number of
 * rooms on the platform — small, and bounded by the same thing that bounds the browse.
 */
export const getJamSessionCities: RequestHandler<unknown, string[]> = async (req, res) => {
  const addresses = await JamSession.distinct('address.formatted', {
    status: 'active',
    date: { $gte: dateStringToUtcMidnight(nowInAppTimezone().date) },
  });

  const cities = addresses
    .map((address: string) => cityFromAddress(address))
    .filter((city): city is string => city !== null);

  // Deduplicated after parsing, not before: two rooms in the same city are two addresses and one
  // option. Sorted with a locale collator so "Nürnberg" files under N rather than after Z, which is
  // where a plain string sort puts every umlaut.
  res.json([...new Set(cities)].sort((a, b) => a.localeCompare(b, 'de')));
};

// A venue's own board, and deliberately not `GET /?venueId=me`. The browse above answers a
// musician's question — "what can I still turn up to?" — and every default it has is shaped by that:
// active only, today onwards. A venue looking at its own sessions wants the opposite of both, and
// getting there through the browse takes an explicit `from` far enough in the past to be arbitrary
// plus a second request for the cancelled ones, because `status` takes one value rather than a list.
// Two round trips and a client-side merge to answer one question.
//
// The identity comes from the access token, never from a query parameter. That is the other half of
// why this is its own route: `?venueId=` is public, so the browse can hand anyone another venue's
// listings — fine, those are public — while this one cannot be pointed at a stranger at all.
export const getMyJamSessions: RequestHandler<unknown, JamSessionOutputDTO[]> = async (req, res) => {
  const venueId = req.user?.userId;

  // authenticate + requireRole('venue') both ran before this, so this cannot be false. It narrows
  // the type — and if the route is ever mounted without its guards, 401 is still the right answer.
  if (!venueId) throw new Error('Not authenticated', { cause: { status: 401 } });

  // No status filter and no date filter: every session this venue has ever posted, cancelled and
  // long past ones included. Those are exactly what the board is for.
  //
  // Newest first, which is the reverse of the browse and for the reverse reason. A musician reads
  // forwards from today; a venue's most recent night is the one it is most likely to be looking for.
  // Deliberately chronological rather than grouped into upcoming-then-past — how the board arranges
  // itself is the client's business, and the moment this endpoint has an opinion about it there are
  // two places to change when the design does.
  const jamSessions = await JamSession.find({ venueId }).sort({ date: -1, startTime: -1 });

  res.json(jamSessions.map((jamSession) => jamSessionOutputSchema.parse(jamSession)));
};

export const getJamSessionById: RequestHandler<IdParams, JamSessionOutputDTO> = async (req, res) => {
  const { id } = req.params;
  const jamSession = await JamSession.findById(id);

  if (!jamSession) throw new Error('Jam session not found', { cause: { status: 404 } });

  // deliberately no status check. JS12 is a rule about the *listing* — someone holding a link, or a
  // musician whose booking is attached to this session, has to be able to see that it was cancelled.
  // Hiding it would show them a 404 for something they know exists.
  res.json(jamSessionOutputSchema.parse(jamSession));
};

export const createJamSession: RequestHandler<
  unknown,
  JamSessionOutputDTO,
  JamSessionInputDTO
> = async (req, res) => {
  const venueId = req.user?.userId;

  // authenticate + requireRole('venue') both ran before this, so this cannot be false. It is here
  // to narrow the type rather than to catch a case — and if the route is ever mounted without its
  // guards, a 401 is the right answer anyway.
  if (!venueId) throw new Error('Not authenticated', { cause: { status: 401 } });

  // JS01 — an access token stays valid for up to 15 minutes after the account behind it is deleted,
  // so holding one is not proof the venue still exists. Skipping this check would write a session
  // whose venueId points at nothing, and nothing downstream would ever notice.
  //
  // The role is re-read from the database rather than trusted from the token for the same reason:
  // requireRole checked what the token *claims*, and the token was minted up to 15 minutes ago.
  const venue = await User.findById(venueId);

  if (!venue || venue.role !== 'venue') {
    throw new Error('Your account is no longer valid. Please log in again', {
      cause: { status: 401 },
    });
  }

  const jamSession = await JamSession.create({
    ...req.body,
    // never from the body — the input schema is a strictObject with no venueId key, so a client
    // that tries to post as another venue gets a 400 rather than being quietly overridden here
    venueId,
    // the one place the "YYYY-MM-DD" string the schemas carry becomes the Date the model stores
    date: dateStringToUtcMidnight(req.body.date),
    // JS03 — generated, never accepted from the client
    slots: generateSlots(req.body),
  });

  res.status(201).json(jamSessionOutputSchema.parse(jamSession));
};

// JS02 — ownership is checked here rather than in a middleware, and the asymmetry with `requireSelf`
// is deliberate. `requireSelf` can be middleware because the answer is already in the URL: compare
// `req.user.userId` to `req.params.id` and you are done. Ownership of a *resource* isn't in the URL,
// so a middleware version would have to load the same document the controller is about to load,
// purely to answer the question — two round trips for one answer.
//
// The 404 comes before the 403 on purpose. Ordering them the other way hides whether a session
// exists, which matters when existence is a secret. Here it isn't: the browse is public, so anyone
// can already discover every session id. A plain "not found" is the more useful answer.
const findOwnedJamSession = async (id: string, userId: string | undefined) => {
  if (!userId) throw new Error('Not authenticated', { cause: { status: 401 } });

  const jamSession = await JamSession.findById(id);

  if (!jamSession) throw new Error('Jam session not found', { cause: { status: 404 } });

  if (String(jamSession.venueId) !== userId) {
    throw new Error('You can only modify your own jam sessions', { cause: { status: 403 } });
  }

  return jamSession;
};

// JS10 — changing any of these once a spot is booked would break the premise the musician booked
// on. `date` is in the list even though it doesn't shape the slots: someone who booked a Tuesday
// did not agree to a Friday.
const FROZEN_ONCE_BOOKED = [
  'date',
  'startTime',
  'endTime',
  'slotDurationMinutes',
  'instrumentTemplate',
] as const satisfies readonly (keyof UpdateJamSessionInput)[];

// The subset that actually changes the generated slots, which is why `date` is absent — slots carry
// times, not dates, so moving a session to another day leaves its 19:00 slot at 19:00.
const RESHAPES_SLOTS = [
  'startTime',
  'endTime',
  'slotDurationMinutes',
  'instrumentTemplate',
] as const satisfies readonly (keyof UpdateJamSessionInput)[];

const touches = (
  update: UpdateJamSessionInput,
  fields: readonly (keyof UpdateJamSessionInput)[],
): boolean => fields.some((field) => update[field] !== undefined);

export const updateJamSession: RequestHandler<
  IdParams,
  JamSessionOutputDTO,
  UpdateJamSessionInput
> = async (req, res) => {
  const { id } = req.params;
  const update = req.body;

  const jamSession = await findOwnedJamSession(id, req.user?.userId);

  // A cancelled session is a tombstone — musicians whose bookings pointed at it still need to see
  // why it is gone. Editing one has no meaning, and refusing here also closes the only route that
  // could otherwise look like un-cancelling.
  if (jamSession.status === 'cancelled') {
    throw new Error('A cancelled jam session cannot be edited', { cause: { status: 409 } });
  }

  const changesShape = touches(update, FROZEN_ONCE_BOOKED);
  const hasBookings = jamSession.slots.some((slot) =>
    slot.spots.some((spot) => spot.bookingId !== null),
  );

  // JS10 — the message names what is frozen rather than just refusing, because from the venue's side
  // "I can't edit my own session" is otherwise indistinguishable from a bug
  if (changesShape && hasBookings) {
    throw new Error(
      'This jam session already has bookings, so its date, times and line-up can no longer be changed',
      { cause: { status: 409 } },
    );
  }

  // The cross-field rules — JS05, JS06, JS07 — cannot run on a partial body, because the sibling
  // field they compare against usually isn't in it. `{ slotDurationMinutes: 45 }` says nothing about
  // whether the window still divides evenly. So the update is merged over the stored document and
  // the *whole* shape is re-validated, which is the only point at which the answer is knowable.
  //
  // Only when a shape field actually changed: re-validating a title edit would re-run the
  // past-date rule and reject an edit to a session happening tonight.
  let merged;

  if (changesShape) {
    // toObject() first — the sub-documents are mongoose Documents, and handing one to a strictObject
    // schema fails on the eighty internal properties it carries
    const stored = jamSession.toObject();

    const candidate = {
      title: stored.title,
      summary: stored.summary,
      image: stored.image,
      date: utcMidnightToDateString(stored.date),
      startTime: stored.startTime,
      endTime: stored.endTime,
      venueName: stored.venueName,
      address: stored.address,
      overview: stored.overview,
      slotDurationMinutes: stored.slotDurationMinutes,
      instrumentTemplate: stored.instrumentTemplate,
      genres: stored.genres,
      skillLevel: stored.skillLevel,
      ...update,
    };

    const revalidated = jamSessionInputSchema.safeParse(candidate);

    if (!revalidated.success) {
      throw new Error(z.prettifyError(revalidated.error), { cause: { status: 400 } });
    }

    merged = revalidated.data;
  }

  jamSession.set({
    ...update,
    // the string the schemas carry becomes the Date the model stores. Mongoose would cast it on its
    // own, but leaving that to chance is how a date quietly lands on the wrong day.
    ...(update.date ? { date: dateStringToUtcMidnight(update.date) } : {}),
    // regenerated from the merged shape, not from the update — a new slotDurationMinutes has to be
    // laid out across the *stored* start and end times. Safe to throw the old slots away only
    // because JS10 has already established that nothing is booked.
    ...(merged && touches(update, RESHAPES_SLOTS) ? { slots: generateSlots(merged) } : {}),
  });

  await jamSession.save();

  res.json(jamSessionOutputSchema.parse(jamSession));
};

// JS11 — cancelling, not deleting. A hard delete would orphan every Booking pointing here and leave
// holes in musicians' booking histories.
export const cancelJamSession: RequestHandler<IdParams, JamSessionOutputDTO> = async (req, res) => {
  const { id } = req.params;

  const jamSession = await findOwnedJamSession(id, req.user?.userId);

  // Idempotent: cancelling an already-cancelled session is the outcome the caller asked for, so it
  // is not an error. A double-click should not produce a 409.
  if (jamSession.status !== 'cancelled') {
    jamSession.set({ status: 'cancelled' });
    await jamSession.save();
  }

  // BK14 — the night is off, so every booking on it is off. Without this a musician's "My bookings"
  // would keep showing "confirmed" for a session the venue called off, which is the kind of thing
  // someone only discovers by turning up.
  //
  // The session is settled first: its status is the authoritative signal, and the bookings follow.
  // Deliberately outside the idempotence check above — running it again on an already-cancelled
  // session matches nothing and costs nothing, and it means a repeat call repairs a cascade that
  // failed halfway rather than skipping it forever.
  //
  // The spots keep their bookingIds. Freeing them would put a dead session's line-up back on the
  // board as if it were available, and nothing can be booked on a cancelled session anyway (BK03).
  await Booking.updateMany(
    { jamSessionId: jamSession._id, status: 'confirmed' },
    { $set: { status: 'cancelled' } },
  );

  res.json(jamSessionOutputSchema.parse(jamSession));
};
