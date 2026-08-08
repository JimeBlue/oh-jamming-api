import type { Types } from 'mongoose';
import JamSession from '#models/JamSession';

// BK06 — the one operation in this app with a genuine concurrency problem.
//
// Two musicians can have the same slot open at the same time. Both see the keyboard spot as free,
// and both submit. The obvious implementation — read the session, check `bookingId === null`, set
// it, save — has a window between the check and the write in which the other request does exactly
// the same thing, and the result is one spot with two musicians expecting to play it. Nothing
// downstream would ever notice; it only surfaces when both of them turn up.
//
// So the check and the write are the same operation. `findOneAndUpdate` matches the spot *and* its
// null `bookingId` in one atomic step, which the database resolves for exactly one of the two
// requests. The loser gets `null` back, which is the whole error signal: no exception, no race, no
// second query.

type SpotReference = {
  jamSessionId: string;
  slotId: string;
  spotId: string;
  // An ObjectId instance, never its string form. Mongoose does not reliably cast values inside
  // `arrayFilters` against the schema, so a string here would be compared against a stored ObjectId
  // and match nothing — a release that silently frees no spot, or a claim that never fails.
  bookingId: Types.ObjectId;
};

// Exactly the fields `Booking` stores denormalized, which is not a coincidence: they are read off
// the spot at the moment it is claimed, and this is the only moment the spot is known to be ours.
export type ClaimedSpot = {
  instrument: string;
  label: string;
  slotStartTime: string;
  slotEndTime: string;
};

export const claimSpot = async ({
  jamSessionId,
  slotId,
  spotId,
  bookingId,
}: SpotReference): Promise<ClaimedSpot | null> => {
  const claimed = await JamSession.findOneAndUpdate(
    {
      _id: jamSessionId,

      // BK03, checked here as well as in the controller. The controller's check is what produces a
      // helpful message; this one closes the window between that read and this write, in which the
      // venue could have cancelled the session.
      status: 'active',

      // This filter is doing the work, and dropping it is the subtle way to break the whole thing:
      // `arrayFilters` alone would still match the *document* by `_id`, update zero array elements,
      // and hand back a document that looks like a successful claim. The `$elemMatch` is what makes
      // "nothing to claim" come back as `null`.
      //
      // Nested `$elemMatch` so both conditions have to hold within a single element rather than
      // across the array: one slot with this `slotId`, containing one spot with this `spotId` that
      // is free.
      slots: {
        $elemMatch: {
          slotId,
          spots: { $elemMatch: { spotId, bookingId: null } },
        },
      },
    },
    { $set: { 'slots.$[slot].spots.$[spot].bookingId': bookingId } },
    {
      // `bookingId: null` is repeated here on purpose. The positional filters are evaluated
      // independently of the query above, so without it a concurrent write landing between the two
      // could still be overwritten.
      arrayFilters: [{ 'slot.slotId': slotId }, { 'spot.spotId': spotId, 'spot.bookingId': null }],
      // the updated document, so the spot we read back is the one carrying our bookingId
      returnDocument: 'after',
      projection: { slots: 1 },
    },
  );

  // The spot was already taken, the slot or spot does not exist, or the session is gone or
  // cancelled. BK05 is deferred, so these are deliberately one answer: telling them apart costs an
  // extra query to distinguish cases that only a hand-crafted request can produce.
  if (!claimed) return null;

  const slot = claimed.slots.find((candidate) => candidate.slotId === slotId);
  const spot = slot?.spots.find((candidate) => candidate.spotId === spotId);

  // Unreachable: the query matched, so both elements existed a moment ago, and `new: true` returns
  // the document that matched. It narrows the types, and if it ever does fire the 500 is correct —
  // something is wrong with the document, not with the request.
  if (!slot || !spot) {
    throw new Error(`Spot ${spotId} could not be read back after being claimed`);
  }

  return {
    instrument: spot.instrument,
    label: spot.label,
    slotStartTime: slot.startTime,
    slotEndTime: slot.endTime,
  };
};

// Frees a spot. Two callers, and they are the same operation seen from different ends:
//
//   BK07 — a multi-spot submission where one claim failed, rolling back the ones that succeeded
//   BK11 — a musician cancelling a booking, putting the spot back on the board
//
// Returns whether a spot was actually freed, which lets a caller tell a real cancellation from a
// repeat of one that already happened.
export const releaseSpot = async ({
  jamSessionId,
  slotId,
  spotId,
  bookingId,
}: SpotReference): Promise<boolean> => {
  const released = await JamSession.findOneAndUpdate(
    {
      _id: jamSessionId,

      // Matching on *our* bookingId rather than on "not null" is what makes this safe to call
      // freely. A release can only ever free a spot this booking holds, so a stale retry, a
      // double-click on cancel, or a rollback racing another musician's fresh claim cannot take a
      // spot away from someone else.
      //
      // No `status: 'active'` condition, unlike the claim: a cancelled session's spots still have
      // to be releasable, or a musician could never cancel a booking on a session the venue
      // called off.
      slots: {
        $elemMatch: {
          slotId,
          spots: { $elemMatch: { spotId, bookingId } },
        },
      },
    },
    { $set: { 'slots.$[slot].spots.$[spot].bookingId': null } },
    {
      arrayFilters: [
        { 'slot.slotId': slotId },
        { 'spot.spotId': spotId, 'spot.bookingId': bookingId },
      ],
      projection: { _id: 1 },
    },
  );

  // Whether anything was freed has to come from the *query* matching, not from the write result.
  // `updateOne` looked like the natural call here and quietly gives the wrong answer: JamSession
  // has `timestamps: true`, so mongoose appends `$set: { updatedAt }` to every update, and the
  // document therefore counts as modified whenever it matches by `_id` — even when the array
  // filters touched no spot at all. `modifiedCount` was answering "did the document change?", not
  // "did we free the spot?".
  return released !== null;
};
