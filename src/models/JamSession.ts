import { randomUUID } from 'node:crypto';
import { Schema, model } from 'mongoose';
import {
  MAX_INSTRUMENTS_PER_SESSION,
  MAX_SLOT_DURATION_MINUTES,
  MAX_SPOTS_PER_INSTRUMENT,
  MIN_SLOT_DURATION_MINUTES,
  genres,
  jamSessionStatuses,
  skillLevels,
} from '#schemas/jamSessionSchema';
import { TIME_PATTERN } from '#utils/time';

// The vocabularies and numeric limits are imported from the zod schema rather than repeated here.
// Both layers still express the same rule — zod rejects the request, mongoose rejects the write —
// but a fourteen-item genre list copied into two files is a list that will disagree with itself
// eventually, and the disagreement would be invisible until a valid request failed at the DB.

// ---------------------------------------------------------------------------------------------
// Sub-schemas
// ---------------------------------------------------------------------------------------------

// `_id: false` throughout. These are embedded values, not entities: the only ones that need
// identity are slots and spots, and they carry their own explicit uuid so that `arrayFilters` in
// the booking claim can match on a field with an obvious name rather than on a nested `_id`.

// One bookable seat. Generated from the venue's instrumentTemplate — never sent by a client.
const SpotSchema = new Schema(
  {
    spotId: {
      type: String,
      default: () => randomUUID(),
    },
    instrument: {
      type: String,
      required: [true, 'instrument is required'],
      trim: true,
    },
    // the human-facing name: "First Lead Guitar". Stored rather than derived so it stays stable
    // even if the template is edited later.
    label: {
      type: String,
      required: [true, 'label is required'],
    },
    // null means available, and this is the only record of that. There is deliberately no
    // "spotsRemaining" counter anywhere — a counter is a second source of truth that has to be kept
    // in step with the spots under concurrency, which is exactly the bug the atomic claim avoids.
    bookingId: {
      type: Schema.Types.ObjectId,
      ref: 'Booking',
      default: null,
    },
  },
  { _id: false },
);

// One time window inside the session, e.g. 19:00–19:45, with its own full set of spots.
const SlotSchema = new Schema(
  {
    slotId: {
      type: String,
      default: () => randomUUID(),
    },
    startTime: {
      type: String,
      required: [true, 'startTime is required'],
      match: [TIME_PATTERN, 'must be a time in HH:mm format'],
    },
    endTime: {
      type: String,
      required: [true, 'endTime is required'],
      match: [TIME_PATTERN, 'must be a time in HH:mm format'],
    },
    spots: {
      type: [SpotSchema],
      default: [],
    },
  },
  { _id: false },
);

// JS14 — coordinates come as a pair or not at all. This has to sit on both paths rather than on one
// of them: mongoose skips validators for `undefined`, so a validator that only lived on `lat` would
// never run in the case it most needs to catch, which is `lat` missing while `lng` is present.
const coordinatesArePaired = function (this: { lat?: number | null; lng?: number | null }) {
  const hasLat = this.lat !== undefined && this.lat !== null;
  const hasLng = this.lng !== undefined && this.lng !== null;

  return hasLat === hasLng;
};

const AddressSchema = new Schema(
  {
    // what gets displayed. The only part of the address that is required — a venue whose room is
    // missing from OpenStreetMap can still type it by hand and post their session.
    formatted: {
      type: String,
      required: [true, 'address.formatted is required'],
      minLength: [5, 'min length is 5 chars'],
      maxLength: [255, 'max length is 255 chars'],
      trim: true,
    },
    // supplied by the client's address autocomplete, and used for exactly one thing: the map pin
    lat: {
      type: Number,
      min: [-90, 'must be between -90 and 90'],
      max: [90, 'must be between -90 and 90'],
      validate: [coordinatesArePaired, 'lat and lng must be provided together'],
    },
    lng: {
      type: Number,
      min: [-180, 'must be between -180 and 180'],
      max: [180, 'must be between -180 and 180'],
      validate: [coordinatesArePaired, 'lat and lng must be provided together'],
    },
  },
  { _id: false },
);

// A block of the long-form description. Only text blocks exist today; the discriminating field is
// here so image or video blocks can be added later without touching stored documents.
//
// NOTE the doubled `type` key. Mongoose reads `{ type: ... }` as a type declaration, so a field
// genuinely named `type` has to be written as `type: { type: String, ... }`. It works, but it reads
// like a mistake, so: it isn't one.
const OverviewBlockSchema = new Schema(
  {
    type: {
      type: String,
      required: [true, 'type is required'],
      enum: {
        values: ['text'],
        message: 'unknown overview block type',
      },
    },
    content: {
      type: String,
      required: [true, 'content is required'],
      maxLength: [2000, 'max length is 2000 chars'],
      trim: true,
    },
  },
  { _id: false },
);

// What the venue's stepper form produces: "Lead Guitar: 3". Kept alongside the generated spots
// because it is the venue's own description of the line-up, and it is what a later edit edits.
const InstrumentTemplateSchema = new Schema(
  {
    instrument: {
      type: String,
      required: [true, 'instrument is required'],
      maxLength: [60, 'max length is 60 chars'],
      trim: true,
    },
    spotsTotal: {
      type: Number,
      required: [true, 'spotsTotal is required'],
      min: [1, 'min is 1 spot'],
      max: [MAX_SPOTS_PER_INSTRUMENT, `max is ${MAX_SPOTS_PER_INSTRUMENT} spots`],
      validate: [Number.isInteger, 'spotsTotal must be a whole number'],
    },
  },
  { _id: false },
);

// ---------------------------------------------------------------------------------------------
// JamSession
// ---------------------------------------------------------------------------------------------

const JamSessionSchema = new Schema(
  {
    // never read from the request body — it is taken from the verified access token, which is what
    // makes "post a session as someone else" unrepresentable rather than merely forbidden
    venueId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'venueId is required'],
    },

    title: {
      type: String,
      required: [true, 'title is required'],
      minLength: [3, 'min length is 3 chars'],
      maxLength: [120, 'max length is 120 chars'],
      trim: true,
    },
    summary: {
      type: String,
      required: [true, 'summary is required'],
      minLength: [10, 'min length is 10 chars'],
      maxLength: [500, 'max length is 500 chars'],
      trim: true,
    },

    // A Cloudinary delivery URL, put there by `POST /uploads/image`. The bytes are never stored
    // here — this field is the whole of the app's relationship with the image. No `required` and no
    // default: a session without a photo is a normal session, and the client draws a placeholder.
    //
    // The host restriction lives in the zod schema rather than here. Mongoose validators run on
    // writes the API makes itself too — the seed script among them — and a rule about what clients
    // are allowed to send belongs at the edge that reads client input.
    image: {
      type: String,
      maxLength: [500, 'max length is 500 chars'],
      trim: true,
    },

    // a calendar day pinned to midnight UTC, not an instant — see `dateStringToUtcMidnight`.
    // The times below are wall-clock strings in APP_TIMEZONE, which is what keeps a 19:00 session
    // at 19:00 on both sides of a DST change.
    date: {
      type: Date,
      required: [true, 'date is required'],
    },
    startTime: {
      type: String,
      required: [true, 'startTime is required'],
      match: [TIME_PATTERN, 'must be a time in HH:mm format'],
    },
    endTime: {
      type: String,
      required: [true, 'endTime is required'],
      match: [TIME_PATTERN, 'must be a time in HH:mm format'],
    },

    // typed per session rather than read off the venue's user account: a promoter may run nights in
    // several different rooms, and the User model has no venue name on it in any case
    venueName: {
      type: String,
      required: [true, 'venueName is required'],
      minLength: [2, 'min length is 2 chars'],
      maxLength: [255, 'max length is 255 chars'],
      trim: true,
    },
    address: {
      type: AddressSchema,
      required: [true, 'address is required'],
    },

    overview: {
      type: [OverviewBlockSchema],
      default: [],
    },

    slotDurationMinutes: {
      type: Number,
      required: [true, 'slotDurationMinutes is required'],
      min: [MIN_SLOT_DURATION_MINUTES, `min is ${MIN_SLOT_DURATION_MINUTES} minutes`],
      max: [MAX_SLOT_DURATION_MINUTES, `max is ${MAX_SLOT_DURATION_MINUTES} minutes`],
      validate: [Number.isInteger, 'slotDurationMinutes must be a whole number'],
    },

    instrumentTemplate: {
      type: [InstrumentTemplateSchema],
      validate: [
        (template: unknown[]) =>
          template.length >= 1 && template.length <= MAX_INSTRUMENTS_PER_SESSION,
        `must have between 1 and ${MAX_INSTRUMENTS_PER_SESSION} instruments`,
      ],
    },

    // `enum` on an array path validates each element
    genres: {
      type: [String],
      enum: {
        values: genres,
        message: 'unknown genre',
      },
      validate: [(values: unknown[]) => values.length >= 1, 'at least one genre is required'],
    },
    skillLevel: {
      type: [String],
      enum: {
        values: skillLevels,
        message: 'unknown skill level',
      },
      validate: [(values: unknown[]) => values.length >= 1, 'at least one skill level is required'],
    },

    // JS11 — sessions are cancelled, never deleted. A hard delete would orphan every Booking
    // pointing at this session, and a musician's booking history would develop holes.
    status: {
      type: String,
      enum: {
        values: jamSessionStatuses,
        message: 'status must be either active or cancelled',
      },
      default: 'active',
    },

    // JS03 — generated server-side from the four fields above plus instrumentTemplate. A client
    // cannot send this: the input schema is a strictObject that has no such key.
    slots: {
      type: [SlotSchema],
      default: [],
    },
  },
  { timestamps: true },
);

// a venue listing its own sessions, and the ownership lookup on every write
JamSessionSchema.index({ venueId: 1 });

// the public browse: active sessions, soonest first. Compound and in this order because the status
// equality has to come before the date range for the index to be usable for both at once.
JamSessionSchema.index({ status: 1, date: 1 });

// the booking claim finds a session by the spot being claimed. Without this, claiming a spot is a
// collection scan — on the one operation that most needs to be quick, because concurrent claims on
// a popular session are precisely the case it exists to handle.
JamSessionSchema.index({ 'slots.spots.spotId': 1 });

export default model('JamSession', JamSessionSchema);
