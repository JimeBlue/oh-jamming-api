import { Schema, model } from 'mongoose';
import { bookingStatuses } from '#schemas/bookingSchema';
import { TIME_PATTERN } from '#utils/time';

// One document per claimed spot. A band claiming five spots in one submission produces five
// documents sharing a `groupId`, and the client regroups them into a single card. The alternative —
// one document holding an array of spots — would make cancelling a single instrument an array
// mutation, and would put the booking's identity at a different granularity from the thing being
// claimed. `JamSession.slots[].spots[].bookingId` points at exactly one of these.
//
// The model name must stay `Booking`: `SpotSchema` in `models/JamSession.ts` already declares
// `ref: 'Booking'`, and mongoose resolves that by name at populate time.

const BookingSchema = new Schema(
  {
    // Deliberately no `default: randomUUID` on either of the two generated fields below. A default
    // fires per document, which would give every spot in one submission its own groupId and its own
    // QR code — the exact opposite of what they are for. The controller generates one of each per
    // submission and passes the same value to every document in the group.
    groupId: {
      type: String,
      required: [true, 'groupId is required'],
    },
    // an opaque token the client renders as a QR image. Shared across the group, so a band presents
    // one code at the door rather than five.
    qrCode: {
      type: String,
      required: [true, 'qrCode is required'],
    },

    jamSessionId: {
      type: Schema.Types.ObjectId,
      ref: 'JamSession',
      required: [true, 'jamSessionId is required'],
    },

    // uuids, not ObjectIds — these are the ids `generateSlots` puts on the embedded slots and spots
    // so `arrayFilters` can match on a named field
    slotId: {
      type: String,
      required: [true, 'slotId is required'],
    },
    spotId: {
      type: String,
      required: [true, 'spotId is required'],
    },

    // never read from the request body — it comes from the verified access token, which is what
    // makes "book as someone else" unrepresentable rather than merely forbidden
    musicianId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'musicianId is required'],
    },

    // Copied off the spot at claim time. These are a snapshot, not a cache to be invalidated: JS10
    // freezes the session's times and line-up as soon as any spot is booked, so they cannot drift
    // while the booking is live. Without them, drawing "My bookings" means fetching every session
    // and walking `slots[]` to find one spot.
    instrument: {
      type: String,
      required: [true, 'instrument is required'],
      trim: true,
      maxLength: [60, 'max length is 60 chars'],
    },
    label: {
      type: String,
      required: [true, 'label is required'],
      trim: true,
      maxLength: [100, 'max length is 100 chars'],
    },
    slotStartTime: {
      type: String,
      required: [true, 'slotStartTime is required'],
      match: [TIME_PATTERN, 'must be a time in HH:mm format'],
    },
    slotEndTime: {
      type: String,
      required: [true, 'slotEndTime is required'],
      match: [TIME_PATTERN, 'must be a time in HH:mm format'],
    },

    bandName: {
      type: String,
      trim: true,
      minLength: [2, 'min length is 2 chars'],
      maxLength: [120, 'max length is 120 chars'],
    },

    // BK11 — bookings are cancelled, never deleted. A hard delete would leave holes in a musician's
    // history and would erase the record a venue needs to know who was supposed to turn up.
    status: {
      type: String,
      enum: {
        values: bookingStatuses,
        message: 'status must be either confirmed or cancelled',
      },
      default: 'confirmed',
    },
  },
  { timestamps: true },
);

// "My bookings" — a musician's own list, split into confirmed and cancelled
BookingSchema.index({ musicianId: 1, status: 1 });

// a venue reading the roster for one of its sessions, and the BK14 cascade when a session is
// cancelled, which updates exactly this set
BookingSchema.index({ jamSessionId: 1, status: 1 });

// regrouping a band's spots back into one card, and cancelling a whole group in one call
BookingSchema.index({ groupId: 1 });

// BK06's backstop. The atomic claim is what *prevents* a double booking; this is what makes it
// impossible — at most one confirmed booking can exist per spot, enforced by the database rather
// than by application code being correct. `spotId` values are `randomUUID()`, so they are unique
// across every session and this needs no session component.
//
// Partial, because cancelled bookings must be allowed to pile up on a spot that has been claimed,
// released and claimed again. Without the filter, the second musician to ever book a given spot
// would collide with the first musician's cancelled row.
BookingSchema.index(
  { spotId: 1 },
  { unique: true, partialFilterExpression: { status: 'confirmed' } },
);

export default model('Booking', BookingSchema);
