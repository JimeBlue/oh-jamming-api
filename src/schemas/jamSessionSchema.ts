import { Types, isValidObjectId } from 'mongoose';
import { z } from 'zod';
import { nowInAppTimezone, timeToMinutes } from '#utils/time';

// ---------------------------------------------------------------------------------------------
// Vocabularies and limits
// ---------------------------------------------------------------------------------------------

// Fixed lists rather than free strings, so the browse filters can rely on exact matches. Free text
// fragments immediately — "Jazz", "jazz" and "JAZZ" become three genres nobody can filter by.
// Safe to extend; the model imports these same arrays, so the two layers cannot drift apart.
export const ALL_GENRES = 'all-genres';
export const genres = [
  ALL_GENRES,
  'blues',
  'electronic',
  'experimental',
  'folk',
  'funk',
  'hip-hop',
  'jazz',
  'latin',
  'metal',
  'pop',
  'reggae',
  'rock',
  'soul',
] as const;

export const ALL_LEVELS = 'all-levels';
export const skillLevels = [ALL_LEVELS, 'beginner', 'intermediate', 'advanced'] as const;

export const jamSessionStatuses = ['active', 'cancelled'] as const;

// A slot shorter than a quarter of an hour isn't a jam, and one longer than four hours isn't a
// slot. Both bounds also keep the generated `slots` array to a sane size.
export const MIN_SLOT_DURATION_MINUTES = 15;
export const MAX_SLOT_DURATION_MINUTES = 240;

// The generation caps. `slots[].spots[]` is an embedded array, so an unbounded template is a way to
// write a multi-megabyte document — 10-minute slots across 12 hours with 20 instruments at 10 spots
// each is 14,400 spots. Mongo's hard ceiling is 16MB per document, and the practical ceiling for a
// document that gets read on every browse is far lower. Rejecting at the edge is much kinder than
// discovering the limit at write time.
export const MAX_SPOTS_PER_INSTRUMENT = 20;
export const MAX_INSTRUMENTS_PER_SESSION = 20;
export const MAX_SLOTS_PER_SESSION = 24;
export const MAX_SPOTS_PER_SESSION = 300;

const MAX_OVERVIEW_BLOCKS = 20;

// The only way a URL gets into `image` is `POST /uploads/image`, which uploads to this project's
// own Cloudinary account and returns a URL under this host. Pinning it is what keeps a session from
// storing a hotlink to somebody else's server: a listing is public, and an <img> pointed anywhere
// is a tracking pixel, an image whose contents can be swapped after the night was posted, or
// somebody else's bandwidth bill.
const CLOUDINARY_URL_PREFIX = 'https://res.cloudinary.com/';

// ---------------------------------------------------------------------------------------------
// Reusable field pieces
// ---------------------------------------------------------------------------------------------

// exactly "HH:mm" — `precision: -1` is what drops the seconds component, so "19:00:00" is rejected
// alongside "7pm". One canonical shape means `timeToMinutes` never has to guess.
const timeField = z.iso.time({ precision: -1, error: 'must be a time in HH:mm format' });

const addressFields = z.strictObject({
  formatted: z
    .string()
    .trim()
    .min(5, 'min length is 5 chars')
    .max(255, 'max length is 255 chars'),

  // Optional on purpose, and only ever used to draw a map pin. Requiring them would mean an
  // outage at the geocoding service — or a rural venue that simply isn't in OpenStreetMap — takes
  // down the ability to post a session at all. Without them the client renders the address as
  // text and skips the map.
  lat: z.number().min(-90, 'must be between -90 and 90').max(90, 'must be between -90 and 90').optional(),
  lng: z
    .number()
    .min(-180, 'must be between -180 and 180')
    .max(180, 'must be between -180 and 180')
    .optional(),
});

// JS14 — a latitude without a longitude is not half a location, it is no location.
const addressField = addressFields.refine(
  ({ lat, lng }) => (lat === undefined) === (lng === undefined),
  { error: 'lat and lng must be provided together', path: ['lat'] },
);

// `type` is a single-value literal rather than a plain string: it is the seam that lets an
// overview grow image or video blocks later without a migration, and today it means an unknown
// block type is a 400 rather than something the client has to defend against.
// Exported because the AI writers have to produce something that fits through here — a model told
// "under 2000 characters" and a schema that rejects 2001 have to be reading the same number, or the
// generator's happy path is a 400 nobody can act on. The summary's minimum matters just as much in
// that direction: a model that answers a thin note with six words has written a value this schema
// refuses.
export const MAX_OVERVIEW_BLOCK_CHARS = 2000;
export const MIN_SUMMARY_CHARS = 10;
export const MAX_SUMMARY_CHARS = 500;

const overviewBlockField = z.strictObject({
  type: z.literal('text'),
  content: z
    .string()
    .trim()
    .min(1, 'content cannot be empty')
    .max(MAX_OVERVIEW_BLOCK_CHARS, `max length is ${MAX_OVERVIEW_BLOCK_CHARS} chars`),
});

const instrumentTemplateField = z.strictObject({
  instrument: z.string().trim().min(1, 'instrument cannot be empty').max(60, 'max length is 60 chars'),
  spotsTotal: z
    .int('spotsTotal must be a whole number')
    .min(1, 'min is 1 spot')
    .max(MAX_SPOTS_PER_INSTRUMENT, `max is ${MAX_SPOTS_PER_INSTRUMENT} spots`),
});

// ---------------------------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------------------------

// A strictObject, so JS03 enforces itself: `slots`, `slotId`, `spotId`, `label` and `bookingId` are
// all server-generated, and a client that sends any of them gets a 400 rather than having the value
// quietly ignored. `venueId` and `status` are absent for the same reason — ownership comes from the
// access token, and status is only ever changed through the cancel endpoint.
const jamSessionFields = z.strictObject({
  title: z.string().trim().min(3, 'min length is 3 chars').max(120, 'max length is 120 chars'),
  summary: z
    .string()
    .trim()
    .min(MIN_SUMMARY_CHARS, `min length is ${MIN_SUMMARY_CHARS} chars`)
    .max(MAX_SUMMARY_CHARS, `max length is ${MAX_SUMMARY_CHARS} chars`),

  // Optional, and it stays that way: every session posted before uploads existed has no image, and
  // a venue in a hurry should be able to put a night on the board without finding a photo first.
  image: z
    .url({ protocol: /^https$/, error: 'must be an https URL' })
    .max(500, 'max length is 500 chars')
    .refine(
      (url) => url.startsWith(CLOUDINARY_URL_PREFIX),
      'must be an image uploaded through POST /uploads/image',
    )
    .optional(),

  // kept as a "YYYY-MM-DD" string here rather than transformed to a Date, because the past-date
  // rule below compares it against the current calendar day in APP_TIMEZONE and both sides sort
  // correctly as strings. The controller converts it with `dateStringToUtcMidnight` on the way to
  // the model, which is where it becomes a Date.
  date: z.iso.date('must be a date in YYYY-MM-DD format'),
  startTime: timeField,
  endTime: timeField,

  venueName: z.string().trim().min(2, 'min length is 2 chars').max(255, 'max length is 255 chars'),
  address: addressField,

  overview: z
    .array(overviewBlockField)
    .max(MAX_OVERVIEW_BLOCKS, `max is ${MAX_OVERVIEW_BLOCKS} blocks`)
    .optional(),

  slotDurationMinutes: z
    .int('slotDurationMinutes must be a whole number')
    .min(MIN_SLOT_DURATION_MINUTES, `min is ${MIN_SLOT_DURATION_MINUTES} minutes`)
    .max(MAX_SLOT_DURATION_MINUTES, `max is ${MAX_SLOT_DURATION_MINUTES} minutes`),

  instrumentTemplate: z
    .array(instrumentTemplateField)
    .min(1, 'at least one instrument is required')
    .max(MAX_INSTRUMENTS_PER_SESSION, `max is ${MAX_INSTRUMENTS_PER_SESSION} instruments`),

  genres: z.array(z.enum(genres, 'unknown genre')).min(1, 'at least one genre is required'),
  skillLevel: z
    .array(z.enum(skillLevels, 'at least one skill level is required'))
    .min(1, 'at least one skill level is required'),
});

// JS09 — "all-genres" means *all* of them, so combining it with a specific genre is a contradiction
// rather than a broader selection. Duplicates are rejected in the same pass: they change nothing
// and would show up twice in the client's tag list.
const catchAllIsExclusive = (
  values: readonly string[] | undefined,
  catchAll: string,
  field: string,
  ctx: z.RefinementCtx,
) => {
  if (!values) return;

  if (new Set(values).size !== values.length) {
    ctx.addIssue({ code: 'custom', path: [field], message: `${field} cannot contain duplicates` });
  }

  if (values.length > 1 && values.includes(catchAll)) {
    ctx.addIssue({
      code: 'custom',
      path: [field],
      message: `"${catchAll}" cannot be combined with specific values`,
    });
  }
};

const jamSessionRules = (
  session: Partial<z.infer<typeof jamSessionFields>>,
  ctx: z.RefinementCtx,
) => {
  const { date, startTime, endTime, slotDurationMinutes, instrumentTemplate } = session;

  catchAllIsExclusive(session.genres, ALL_GENRES, 'genres', ctx);
  catchAllIsExclusive(session.skillLevel, ALL_LEVELS, 'skillLevel', ctx);

  // JS08 — two "Drums" entries would silently produce "First Drums" twice over, with no way for a
  // musician to tell the two apart in the booking UI
  if (instrumentTemplate) {
    const names = instrumentTemplate.map(({ instrument }) => instrument.toLowerCase());

    if (new Set(names).size !== names.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['instrumentTemplate'],
        message: 'each instrument can only appear once',
      });
    }
  }

  // JS05 — a session in the past cannot be booked, so accepting one only produces dead data.
  // Both comparisons are plain string comparisons: ISO dates and "HH:mm" times sort correctly.
  if (date && startTime) {
    const now = nowInAppTimezone();

    if (date < now.date) {
      ctx.addIssue({ code: 'custom', path: ['date'], message: 'date cannot be in the past' });
    } else if (date === now.date && startTime <= now.time) {
      ctx.addIssue({
        code: 'custom',
        path: ['startTime'],
        message: 'startTime has already passed today',
      });
    }
  }

  if (!startTime || !endTime || !slotDurationMinutes) return;

  const windowMinutes = timeToMinutes(endTime) - timeToMinutes(startTime);

  // JS05 — also rules out a session that crosses midnight. Those are real (a jam ending at 02:00)
  // but they need a second calendar date to be unambiguous, which the data model doesn't carry.
  // Better to reject them clearly than to store 22:00–02:00 and let every consumer guess.
  if (windowMinutes <= 0) {
    ctx.addIssue({ code: 'custom', path: ['endTime'], message: 'endTime must be after startTime' });
    return;
  }

  // JS06 — 19:00–21:30 in 45-minute slots leaves a 15-minute stub. Rejecting is the honest answer:
  // silently dropping the remainder loses bookable time the venue thought it was offering, and
  // silently keeping it produces a slot that isn't the length the venue chose.
  if (windowMinutes % slotDurationMinutes !== 0) {
    ctx.addIssue({
      code: 'custom',
      path: ['slotDurationMinutes'],
      message: `${windowMinutes} minutes does not divide evenly into ${slotDurationMinutes}-minute slots`,
    });
    return;
  }

  // JS07 — the caps are checked here, before generation, so the venue gets a 400 explaining what to
  // change rather than a 500 from a document that was too big to write
  const slotCount = windowMinutes / slotDurationMinutes;

  if (slotCount > MAX_SLOTS_PER_SESSION) {
    ctx.addIssue({
      code: 'custom',
      path: ['slotDurationMinutes'],
      message: `that would create ${slotCount} slots, and the max is ${MAX_SLOTS_PER_SESSION}`,
    });
    return;
  }

  if (!instrumentTemplate) return;

  const spotsPerSlot = instrumentTemplate.reduce((total, { spotsTotal }) => total + spotsTotal, 0);
  const totalSpots = slotCount * spotsPerSlot;

  if (totalSpots > MAX_SPOTS_PER_SESSION) {
    ctx.addIssue({
      code: 'custom',
      path: ['instrumentTemplate'],
      message: `that would create ${totalSpots} spots across ${slotCount} slots, and the max is ${MAX_SPOTS_PER_SESSION}`,
    });
  }
};

export const jamSessionInputSchema = jamSessionFields.superRefine(jamSessionRules);

export type JamSessionInput = z.infer<typeof jamSessionInputSchema>;

// ---------------------------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------------------------

// No cross-field rules here, for the same reason `updateUserSchema` drops `instrumentsMatchRole`:
// with `.partial()` the sibling field is usually absent from the body, so there is nothing to
// compare against. A body changing only `slotDurationMinutes` cannot be checked for JS06 in
// isolation — the controller merges the body over the stored document and re-runs
// `jamSessionInputSchema` on the result, which is the only point where the whole shape is known.
//
// `status` is absent by design: cancelling is its own endpoint, not a field edit (JS11).
export const updateJamSessionSchema = jamSessionFields
  .partial()
  .refine((update) => Object.keys(update).length > 0, 'at least one field is required');

export type UpdateJamSessionInput = z.infer<typeof updateJamSessionSchema>;

// ---------------------------------------------------------------------------------------------
// Query
// ---------------------------------------------------------------------------------------------

// A page of the browse, 12 at a time. The grid is four across at `xl` and three at `lg`, so twelve
// is the one size that fills both without a ragged last row.
export const DEFAULT_PAGE_SIZE = 12;

// The cap exists because `limit` is a number from a query string. Without it `?limit=999999` is the
// unpaginated query with extra steps — every session on the platform, serialised with its whole
// `slots` array, from a public endpoint nobody has to log in to reach.
export const MAX_PAGE_SIZE = 48;

// The browse filters. A strictObject here too, which matters more than it looks: `?genr=jazz` would
// otherwise be silently ignored and return every session, and a filter that quietly does nothing is
// a much worse bug than one that says it doesn't recognise the parameter.
//
// The filters below need no coercing — the enums and `z.iso.date()` all parse strings already. The
// two paging fields are the exception, and are the only reason `z.coerce` appears in this file.
export const jamSessionQuerySchema = z
  .strictObject({
    genre: z.enum(genres, 'unknown genre').optional(),
    skillLevel: z.enum(skillLevels, 'unknown skill level').optional(),

    // JS12 — omitted means active. Cancelled sessions are still reachable, just never by accident.
    status: z.enum(jamSessionStatuses, 'unknown status').optional(),

    venueId: z.string().refine(isValidObjectId, 'must be a valid id').optional(),

    // A substring of the address, not a field of it. `address` is a single free-text `formatted`
    // line — there is no city on the model — so this is matched with a case-insensitive regex over
    // the whole line, which finds "Berlin" in "Torstraße 1, 10119 Berlin" and equally finds it in a
    // street called Berliner Allee. That imprecision is the deal: a real city field means changing
    // the address shape, the wizard's geocoding step and every session already stored, and the
    // filter is worth having before that is worth doing.
    //
    // Bounded at 60 because it goes into a RegExp. The controller escapes it — an unescaped `(((`
    // from a query string is a crash, and an unescaped `(a+)+$` is a CPU pinned for the afternoon —
    // and a short cap is the second half of that defence.
    city: z.string().trim().min(2, 'min length is 2 chars').max(60, 'max length is 60 chars').optional(),

    // JS13 — `from` omitted means "today onwards". Passing it explicitly is how a venue looks at
    // its own past nights.
    from: z.iso.date('must be a date in YYYY-MM-DD format').optional(),
    to: z.iso.date('must be a date in YYYY-MM-DD format').optional(),

    // 1-based, because it is the number drawn on the button. Converting to a 0-based offset is one
    // multiplication in the controller; explaining to whoever writes the next client why page one
    // is `?page=0` is forever.
    //
    // Optional, with the defaults applied in the controller rather than by `.default()` here. That
    // is the opposite of the usual advice and it is deliberate: this schema's inferred type is also
    // what `ai.ts` builds when the model reads a sentence into filters, and a search for "jazz in
    // Berlin" has no opinion about which page of the results the musician wants. Defaulting here
    // would make `page` and `limit` required on every one of those objects — paging leaking into a
    // type that is about filtering.
    page: z.coerce
      .number('must be a number')
      .int('must be a whole number')
      .min(1, 'must be at least 1')
      .optional(),

    // `.max()` rather than a silent clamp. A clamp would answer `?limit=1000` with 48 items and no
    // indication that it had ignored the question, which reads to the caller as "there are only 48"
    // — the same class of quiet lie the strictObject above exists to prevent.
    limit: z.coerce
      .number('must be a number')
      .int('must be a whole number')
      .min(1, 'must be at least 1')
      .max(MAX_PAGE_SIZE, `max is ${MAX_PAGE_SIZE}`)
      .optional(),
  })
  .refine(({ from, to }) => !from || !to || from <= to, {
    error: 'to must not be earlier than from',
    path: ['to'],
  });

export type JamSessionQuery = z.infer<typeof jamSessionQuerySchema>;

// ---------------------------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------------------------

// Mongoose hands back ObjectId instances, not strings. `id` is already a string thanks to the
// global `id` virtual set in `db/index.ts`, but `venueId` and `bookingId` are raw and have to be
// normalised here so the client never has to deal with `{ $oid: ... }` shaped values.
const objectIdOutput = z
  .union([z.string(), z.instanceof(Types.ObjectId)])
  .transform((value) => String(value));

// The nested shapes are rebuilt as plain `z.object`s rather than reusing the strictObjects above,
// and the reason is not cosmetic: these parse *mongoose documents*, and an embedded subdocument
// carries its whole prototype — `_doc`, `$__parent`, `save`, `toObject` and eighty more. A
// strictObject sees all of that as unrecognized keys and refuses the parse; a plain object strips
// it. Strictness belongs on the way in, where an unexpected key means the client sent something
// wrong. On the way out it would only mean mongoose is mongoose.
//
// The field *rules* are still shared via `.shape`, so there is one definition of what a valid
// address or overview block looks like.
const addressOutputSchema = z.object(addressFields.shape);
const overviewBlockOutputSchema = z.object(overviewBlockField.shape);
const instrumentTemplateOutputSchema = z.object(instrumentTemplateField.shape);

const spotOutputSchema = z.object({
  spotId: z.string(),
  instrument: z.string(),
  label: z.string(),
  // null means available. This is the whole availability model — there is no separate counter to
  // fall out of sync with the spots themselves.
  bookingId: objectIdOutput.nullable(),
});

const slotOutputSchema = z.object({
  slotId: z.string(),
  startTime: timeField,
  endTime: timeField,
  spots: z.array(spotOutputSchema),
});

export const jamSessionOutputSchema = z.object({
  id: z.string(),
  venueId: objectIdOutput,

  title: jamSessionFields.shape.title,
  summary: jamSessionFields.shape.summary,

  // a plain optional string rather than the input field above, for the same reason `address` drops
  // its pairing refinement: the host check is an input concern. Re-running it on the way out would
  // turn a document stored before the rule existed — or one seeded with a fixture image — into a
  // 500 on read.
  image: z.string().optional(),

  date: z.date(),
  startTime: timeField,
  endTime: timeField,

  venueName: jamSessionFields.shape.venueName,
  // the unrefined shape rather than `addressField` — the pairing rule is an input concern, and
  // re-running it on the way out would turn a stored document into a 500
  address: addressOutputSchema,

  overview: z.array(overviewBlockOutputSchema),
  slotDurationMinutes: jamSessionFields.shape.slotDurationMinutes,
  instrumentTemplate: z.array(instrumentTemplateOutputSchema),

  genres: jamSessionFields.shape.genres,
  skillLevel: jamSessionFields.shape.skillLevel,
  status: z.enum(jamSessionStatuses),

  slots: z.array(slotOutputSchema),

  createdAt: z.date(),
  updatedAt: z.date(),
});

export type JamSessionOutput = z.infer<typeof jamSessionOutputSchema>;

/* What `GET /jam-sessions` returns: one page, plus what the caller needs to draw a pager.
 *
 * A hand-written type rather than a Zod schema, which is the one place in this file that breaks the
 * pattern. Every other output shape is a schema because it parses a mongoose document on the way
 * out — this one wraps values the controller has already parsed, and running `items` through a
 * second `z.array(jamSessionOutputSchema)` would re-validate the whole page to prove nothing.
 *
 * `total` is the count of everything matching the filter, not the length of `items`, and it is the
 * only reason this is an object at all: how many pages there are is unanswerable from a page.
 * `page` and `limit` are echoed back so the client renders what the server actually did rather than
 * what it asked for — they differ whenever a default filled one in.
 */
export type JamSessionPageOutput = {
  items: JamSessionOutput[];
  total: number;
  page: number;
  limit: number;
};
