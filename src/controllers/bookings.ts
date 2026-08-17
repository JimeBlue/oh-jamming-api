import { randomUUID } from 'node:crypto';
import type { RequestHandler } from 'express';
import { Types } from 'mongoose';
import Booking from '#models/Booking';
import JamSession from '#models/JamSession';
import User from '#models/User';
import type {
  BookingDetailOutput,
  BookingInput,
  BookingOutput,
  BookingQuery,
  GroupIdParams,
} from '#schemas/bookingSchema';
import { bookingDetailOutputSchema, bookingOutputSchema } from '#schemas/bookingSchema';
import type { IdParams } from '#schemas/idParamSchema';
import { claimSpot, releaseSpot } from '#utils/claimSpot';
import { nowInAppTimezone, utcMidnightToDateString } from '#utils/time';

// BK17 — bookings are never public. Unlike jam sessions, where browsing is the product, a booking
// says who is playing what and when, and the only people with a claim to that are the musician who
// made it and the venue running the night.
//
// Both reads populate. A booking on its own is a set of ids: the session's title and the musician's
// name live in other collections, and without them neither "My bookings" nor a venue's roster can
// draw a single row.
const POPULATE = [
  // `address` is here for the musician's own list, which shows where to turn up. It is not a
  // widening of what a booking exposes: the session is public and browsable by anyone, address
  // included, so this only saves the client a second request for something it could already read.
  { path: 'jamSessionId', select: 'title date venueName status address' },
  // BK18 — name and email, and nothing else. The projection *is* the rule: whatever is not selected
  // here cannot be leaked by a careless render, because it never leaves the database.
  //
  // The email is here because the alternative was worse than the risk. A venue cancelling a night at
  // short notice, or moving a slot, had no way to tell the people who had signed up for it — and
  // "who do I contact?" is the whole reason a guest list exists. Every account this returns belongs
  // to somebody who chose to book *this venue's* night, which is what makes it a relationship rather
  // than a lookup.
  //
  // What BK18 still protects is the other direction: there is no route that turns a name into an
  // account. `GET /users/:id` is `requireSelf`, and there is no users index, so a venue cannot read
  // the address of anyone it has no booking with. The filter on this route composes with the
  // ownership scope rather than replacing it, so it cannot be pointed at another venue's roster
  // either. Contact details for your own guests, and no directory.
  { path: 'musicianId', select: 'firstName lastName email' },
];

// Soonest gig first, matching `getJamSessions`. The sort has to happen after parsing rather than in
// mongo, because the date being sorted on lives on the *jam session* — mongo cannot sort one
// collection by a field in another without an aggregation, and the list is a personal one, not a
// feed. `slotStartTime` breaks ties within a day, and sorts correctly as a string because it is
// "HH:mm".
const soonestFirst = (a: BookingDetailOutput, b: BookingDetailOutput): number =>
  Number(a.jamSession.date) - Number(b.jamSession.date) ||
  a.slotStartTime.localeCompare(b.slotStartTime);

export const getBookings: RequestHandler<
  unknown,
  BookingDetailOutput[],
  unknown,
  BookingQuery
> = async (req, res) => {
  const userId = req.user?.userId;
  const role = req.user?.role;
  const { jamSessionId } = req.query;

  // `authenticate` ran before this, so neither can be missing. Here to narrow the type — and if the
  // route is ever mounted without its guard, 401 is the right answer anyway.
  if (!userId || !role) throw new Error('Not authenticated', { cause: { status: 401 } });

  // Two shapes of the same question. A musician asks "what am I playing?", a venue asks "who is
  // playing at my nights?" — one endpoint, because the answer is the same list seen from either
  // end, and splitting it would mean the client has to know its own role to pick a URL.
  //
  // `jamSessionId` narrows whichever shape applies, and in both branches it is *added* to the
  // ownership clause rather than replacing it. That is the whole security argument: a session id is
  // public, so a filter that stood on its own would hand any venue any other venue's roster.
  let filter;

  if (role === 'venue') {
    // The venue's own sessions, resolved first. An aggregation with `$lookup` would do this in one
    // round trip, but a venue has tens of sessions, not thousands, and `$in` over their ids uses
    // the `{ jamSessionId, status }` index — which a `$lookup` would not.
    //
    // With a `jamSessionId` this is still one query, now matching at most one document: the
    // `venueId` clause is what turns "the session you named" into "the session you named, if it is
    // yours", so ownership is enforced by the same filter that resolves the ids.
    const ownSessions = await JamSession.find({
      venueId: userId,
      ...(jamSessionId ? { _id: jamSessionId } : {}),
    }).select('_id');

    // A venue with no sessions — or one asking about a session that isn't theirs — gets `$in: []`,
    // which matches nothing. Correct, and one fewer special case than checking for it. An empty
    // list rather than a 403 on purpose: this is a filter, and a filter that matches nothing has
    // done its job. The client only ever passes ids it read off its own board.
    filter = { jamSessionId: { $in: ownSessions.map(({ _id }) => _id) } };
  } else {
    filter = { musicianId: userId, ...(jamSessionId ? { jamSessionId } : {}) };
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

// ---------------------------------------------------------------------------------------------
// Creating
// ---------------------------------------------------------------------------------------------

// What one spot looks like between being claimed and being written: the id reserved for it, the
// spot it belongs to, and the display fields read off that spot at the moment it became ours.
type PendingBooking = {
  bookingId: Types.ObjectId;
  spotId: string;
  instrument: string;
  label: string;
  slotStartTime: string;
  slotEndTime: string;
};

export const createBooking: RequestHandler<unknown, BookingOutput[], BookingInput> = async (
  req,
  res,
) => {
  const musicianId = req.user?.userId;

  if (!musicianId) throw new Error('Not authenticated', { cause: { status: 401 } });

  // BK02 — an access token stays valid for up to 15 minutes after the account behind it is deleted,
  // so holding one is not proof the musician still exists. The role is re-read rather than trusted
  // from the token for the same reason: `requireRole` checked what the token *claims*, and the
  // token was minted up to 15 minutes ago.
  const musician = await User.findById(musicianId);

  if (!musician || musician.role !== 'musician') {
    throw new Error('Your account is no longer valid. Please log in again', {
      cause: { status: 401 },
    });
  }

  const { jamSessionId, slotId, spotIds, bandName } = req.body;

  const jamSession = await JamSession.findById(jamSessionId);

  if (!jamSession) throw new Error('Jam session not found', { cause: { status: 404 } });

  // BK03 — checked here for a message the musician can act on. `claimSpot` checks it again as part
  // of its atomic filter, which is what closes the window between this read and the write.
  if (jamSession.status !== 'active') {
    throw new Error('This jam session has been cancelled', { cause: { status: 409 } });
  }

  const slot = jamSession.slots.find((candidate) => candidate.slotId === slotId);

  if (!slot) throw new Error('Time slot not found', { cause: { status: 404 } });

  // BK04 — per slot, not per session: at 20:30 tonight the 20:00 slot is gone but the 21:00 one is
  // still bookable. Both comparisons are plain string comparisons — ISO dates and "HH:mm" times
  // sort in the same order they run.
  const now = nowInAppTimezone();
  const sessionDate = utcMidnightToDateString(jamSession.date);

  if (sessionDate < now.date || (sessionDate === now.date && slot.startTime <= now.time)) {
    throw new Error('That time slot has already started', { cause: { status: 409 } });
  }

  // One per submission, not one per document — which is why neither has a `default` on the model.
  // A band presents a single QR code at the door and appears as a single card in "My bookings".
  const groupId = randomUUID();
  const qrCode = randomUUID();

  const claimed: PendingBooking[] = [];

  // Everything acquired so far goes back on the board. Used by both failure paths below, and safe
  // to call in either: `releaseSpot` matches on our own bookingId, so it can only ever free spots
  // this request is holding.
  const releaseAll = async () => {
    await Promise.all(
      claimed.map((pending) =>
        releaseSpot({
          jamSessionId,
          slotId,
          spotId: pending.spotId,
          bookingId: pending.bookingId,
        }),
      ),
    );
  };

  // Claimed one at a time rather than in parallel. The submission is capped at ten spots (BK08), so
  // the round trips are bounded, and sequential means a submission that is going to fail stops at
  // the first refusal instead of acquiring the rest only to hand them straight back.
  for (const spotId of spotIds) {
    // BK06 — the id is reserved *before* the claim, because the claim has to write something into
    // `bookingId` and the Booking document does not exist yet. It gets used as the document's `_id`
    // below, so the spot and the booking point at each other from the first moment either exists.
    const bookingId = new Types.ObjectId();
    const spot = await claimSpot({ jamSessionId, slotId, spotId, bookingId });

    if (!spot) {
      // BK07 — all or nothing. A band that asked for five spots and got three is a worse outcome
      // than a band that got none and knows it: there is no HTTP status meaning "some of this
      // worked", and a partial success would have to be explained on a thank-you page.
      await releaseAll();

      // Named from the session we already loaded, so the message says which instrument to re-pick.
      // Falls back to a generic message when the spotId isn't in the slot at all — BK05 is
      // deferred, so an unknown spot and a taken one deliberately give the same answer.
      const label = slot.spots.find((candidate) => candidate.spotId === spotId)?.label;

      throw new Error(
        label
          ? `The ${label} spot at ${slot.startTime} is no longer available. Please choose another`
          : 'That spot is no longer available. Please choose another',
        { cause: { status: 409 } },
      );
    }

    claimed.push({ bookingId, spotId, ...spot });
  }

  try {
    const bookings = await Booking.insertMany(
      claimed.map((pending) => ({
        _id: pending.bookingId,
        groupId,
        qrCode,
        jamSessionId,
        slotId,
        spotId: pending.spotId,
        musicianId,
        instrument: pending.instrument,
        label: pending.label,
        slotStartTime: pending.slotStartTime,
        slotEndTime: pending.slotEndTime,
        ...(bandName ? { bandName } : {}),
      })),
    );

    res.status(201).json(bookings.map((booking) => bookingOutputSchema.parse(booking)));
  } catch (error) {
    // The spots are held but the documents that justify holding them were never written. Without
    // this the spots would be unbookable forever, with nothing anywhere recording why.
    await releaseAll();
    throw error;
  }
};

// ---------------------------------------------------------------------------------------------
// Cancelling
// ---------------------------------------------------------------------------------------------

// BK11 — cancel then release, and the order is the interesting part. Both writes can't be one
// operation, so one of two things can go wrong if the second never happens:
//
//   release first  → the spot is free while the booking still says "confirmed", and the musician is
//                    holding a receipt for a spot somebody else can now take
//   cancel first   → the booking is cancelled while the spot stays held, so one spot goes unsold
//
// The second is a smaller, quieter failure: nobody ends up with a booking that isn't real. So the
// document is settled first and the spot is freed after.
const cancelOne = async (booking: InstanceType<typeof Booking>) => {
  if (booking.status === 'cancelled') return;

  booking.set({ status: 'cancelled' });
  await booking.save();

  await releaseSpot({
    jamSessionId: String(booking.jamSessionId),
    slotId: booking.slotId,
    spotId: booking.spotId,
    bookingId: booking._id,
  });
};

export const cancelBooking: RequestHandler<IdParams, BookingOutput> = async (req, res) => {
  const { id } = req.params;
  const musicianId = req.user?.userId;

  if (!musicianId) throw new Error('Not authenticated', { cause: { status: 401 } });

  const booking = await Booking.findById(id);

  if (!booking) throw new Error('Booking not found', { cause: { status: 404 } });

  // BK12 — only the musician who made it. A venue that wants a booking gone cancels the session;
  // it has no way to remove one musician from a night it is still running, which is deliberate.
  if (String(booking.musicianId) !== musicianId) {
    throw new Error('You can only cancel your own bookings', { cause: { status: 403 } });
  }

  // Idempotent: cancelling an already-cancelled booking is the outcome the caller asked for, so a
  // double-click is not a 409.
  await cancelOne(booking);

  res.json(bookingOutputSchema.parse(booking));
};

// Cancelling a whole band booking in one call. The client's "My bookings" draws a group as a single
// card with a single button, and doing it in one request is what stops five separate calls from
// half-failing and leaving a band holding two spots it no longer wants.
export const cancelBookingGroup: RequestHandler<GroupIdParams, BookingOutput[]> = async (
  req,
  res,
) => {
  const { groupId } = req.params;
  const musicianId = req.user?.userId;

  if (!musicianId) throw new Error('Not authenticated', { cause: { status: 401 } });

  const bookings = await Booking.find({ groupId });

  if (bookings.length === 0) throw new Error('Booking not found', { cause: { status: 404 } });

  // BK12 again. Every document in a group is written by one request for one musician, so this
  // cannot be partly true — checking the first would be enough, and checking all of them is how it
  // stays correct if that ever stops being the case.
  if (bookings.some((booking) => String(booking.musicianId) !== musicianId)) {
    throw new Error('You can only cancel your own bookings', { cause: { status: 403 } });
  }

  // Sequentially, for the same reason the claims are sequential: at most ten documents, and each
  // one is a save plus a release on the same jam session document.
  for (const booking of bookings) {
    await cancelOne(booking);
  }

  res.json(bookings.map((booking) => bookingOutputSchema.parse(booking)));
};
