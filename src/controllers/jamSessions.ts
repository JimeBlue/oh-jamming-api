import type { RequestHandler } from 'express';
import type { z } from 'zod';
import JamSession from '#models/JamSession';
import User from '#models/User';
import type { IdParams } from '#schemas/idParamSchema';
import {
  ALL_GENRES,
  ALL_LEVELS,
  type JamSessionQuery,
  type jamSessionInputSchema,
  jamSessionOutputSchema,
} from '#schemas/jamSessionSchema';
import { generateSlots } from '#utils/slots';
import { dateStringToUtcMidnight, nowInAppTimezone } from '#utils/time';

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

export const getJamSessions: RequestHandler<
  unknown,
  JamSessionOutputDTO[],
  unknown,
  JamSessionQuery
> = async (req, res) => {
  const { genre, skillLevel, status, venueId, from, to } = req.query;

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

  // soonest first, and within a day the earlier start first — `startTime` is "HH:mm", which sorts
  // lexicographically in the same order it sorts chronologically
  const jamSessions = await JamSession.find(filter).sort({ date: 1, startTime: 1 });

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
