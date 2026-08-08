import type { RequestHandler } from 'express';
import Booking from '#models/Booking';
import JamSession from '#models/JamSession';
import type { BookingDetailOutput } from '#schemas/bookingSchema';
import { bookingDetailOutputSchema } from '#schemas/bookingSchema';
import type { IdParams } from '#schemas/idParamSchema';

// BK17 — bookings are never public. Unlike jam sessions, where browsing is the product, a booking
// says who is playing what and when, and the only people with a claim to that are the musician who
// made it and the venue running the night.
//
// Both reads populate. A booking on its own is a set of ids: the session's title and the musician's
// name live in other collections, and without them neither "My bookings" nor a venue's roster can
// draw a single row.
const POPULATE = [
  { path: 'jamSessionId', select: 'title date venueName status' },
  // BK18 — name only. The projection *is* the rule: there is no email on the populated document for
  // the output schema to have to remember to drop.
  { path: 'musicianId', select: 'firstName lastName' },
];

// Soonest gig first, matching `getJamSessions`. The sort has to happen after parsing rather than in
// mongo, because the date being sorted on lives on the *jam session* — mongo cannot sort one
// collection by a field in another without an aggregation, and the list is a personal one, not a
// feed. `slotStartTime` breaks ties within a day, and sorts correctly as a string because it is
// "HH:mm".
const soonestFirst = (a: BookingDetailOutput, b: BookingDetailOutput): number =>
  Number(a.jamSession.date) - Number(b.jamSession.date) ||
  a.slotStartTime.localeCompare(b.slotStartTime);

export const getBookings: RequestHandler<unknown, BookingDetailOutput[]> = async (req, res) => {
  const userId = req.user?.userId;
  const role = req.user?.role;

  // `authenticate` ran before this, so neither can be missing. Here to narrow the type — and if the
  // route is ever mounted without its guard, 401 is the right answer anyway.
  if (!userId || !role) throw new Error('Not authenticated', { cause: { status: 401 } });

  // Two shapes of the same question. A musician asks "what am I playing?", a venue asks "who is
  // playing at my nights?" — one endpoint, because the answer is the same list seen from either
  // end, and splitting it would mean the client has to know its own role to pick a URL.
  let filter;

  if (role === 'venue') {
    // The venue's own sessions, resolved first. An aggregation with `$lookup` would do this in one
    // round trip, but a venue has tens of sessions, not thousands, and `$in` over their ids uses
    // the `{ jamSessionId, status }` index — which a `$lookup` would not.
    const ownSessions = await JamSession.find({ venueId: userId }).select('_id');

    // A venue with no sessions gets `$in: []`, which matches nothing. Correct, and one fewer
    // special case than checking for it.
    filter = { jamSessionId: { $in: ownSessions.map(({ _id }) => _id) } };
  } else {
    filter = { musicianId: userId };
  }

  const bookings = await Booking.find(filter).populate(POPULATE);

  // Cancelled bookings are included on purpose. They are the musician's history and the venue's
  // record of who dropped out, and hiding them would make a cancellation look like it never
  // happened. The client already has `status` to split the list on.
  res.json(bookings.map((booking) => bookingDetailOutputSchema.parse(booking)).sort(soonestFirst));
};

export const getBookingById: RequestHandler<IdParams, BookingDetailOutput> = async (req, res) => {
  const { id } = req.params;
  const userId = req.user?.userId;

  if (!userId) throw new Error('Not authenticated', { cause: { status: 401 } });

  const booking = await Booking.findById(id);

  if (!booking) throw new Error('Booking not found', { cause: { status: 404 } });

  // BK17 — the musician who made it, or the venue whose session it is. The ownership check runs
  // against the raw ids, *before* populating: the venue lookup is a second query and only the venue
  // path pays for it, and comparing ids is unambiguous in a way that comparing populated documents
  // is not.
  if (String(booking.musicianId) !== userId) {
    const jamSession = await JamSession.findById(booking.jamSessionId).select('venueId');

    if (!jamSession || String(jamSession.venueId) !== userId) {
      throw new Error('You can only view your own bookings', { cause: { status: 403 } });
    }
  }

  // The 404 deliberately precedes the 403, as it does on jam sessions. Booking ids are `_id`s that
  // nobody can guess, so ordering them the other way would protect nothing and would answer "does
  // this exist?" with a 403 for the owner's own mistyped id.
  await booking.populate(POPULATE);

  res.json(bookingDetailOutputSchema.parse(booking));
};
