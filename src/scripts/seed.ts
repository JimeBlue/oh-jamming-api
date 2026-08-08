import { randomUUID } from 'node:crypto';
import mongoose, { Types } from 'mongoose';
import { z } from 'zod';
import { isProduction } from '#config';
import connectDB from '#db/index';
import Booking from '#models/Booking';
import JamSession from '#models/JamSession';
import User from '#models/User';
import { jamSessionInputSchema } from '#schemas/jamSessionSchema';
import { claimSpot, releaseSpot } from '#utils/claimSpot';
import { generateSlots } from '#utils/slots';
import {
  dateStringToUtcMidnight,
  nowInAppTimezone,
  utcMidnightToDateString,
} from '#utils/time';

// Demo data for developing the client against: venues, musicians, jam sessions, and enough existing
// bookings that the booking UI has every state to render — a full slot, a partly full one, a band
// booking to regroup, and a cancelled one in the history.
//
// Run with `npm run seed`. It is safe to re-run: each run removes what the previous run created and
// starts again, so a board you have booked into pieces goes back to a known state.

// ---------------------------------------------------------------------------------------------
// Safety
// ---------------------------------------------------------------------------------------------

// This writes to the same database the deployed app uses, so "delete everything and start again" is
// not an option. Every account created here has this email domain, and it is the only handle the
// cleanup uses: demo users are found by it, their jam sessions by their ids, and the bookings by
// those sessions. Nothing the user made by hand is ever matched, and no collection is ever cleared.
const DEMO_DOMAIN = 'ohjamming.demo';

// Obviously fake, and in git on purpose so any of the seeded accounts can be logged into while
// building the client. It must never be a password used anywhere real.
const DEMO_PASSWORD = 'demopassword';

if (isProduction) {
  console.error('refusing to run: seeding is a development task and NODE_ENV is production');
  process.exit(1);
}

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

const must = <T>(value: T | undefined, message: string): T => {
  if (value === undefined) throw new Error(message);
  return value;
};

// Dates are relative to today, never hardcoded. A fixed date is fine for a week and then quietly
// rots: the sessions fall into the past, drop out of the default browse (JS13), and the script has
// to be edited before it is useful again. Arithmetic on UTC midnight, so no DST to think about.
const today = nowInAppTimezone().date;

const inDays = (days: number): string =>
  utcMidnightToDateString(new Date(dateStringToUtcMidnight(today).getTime() + days * 86_400_000));

const email = (name: string) => `${name}@${DEMO_DOMAIN}`;

// ---------------------------------------------------------------------------------------------
// The people
// ---------------------------------------------------------------------------------------------

const venuePeople = [
  { firstName: 'Ana', lastName: 'Keller', email: email('ana') },
  { firstName: 'Bruno', lastName: 'Weiss', email: email('bruno') },
  { firstName: 'Clara', lastName: 'Hoffmann', email: email('clara') },
  { firstName: 'Dieter', lastName: 'Lang', email: email('dieter') },
];

const musicianPeople = [
  // the account to log in as while building "My bookings" — every kind of booking below belongs to
  // this one, including the band group and the cancelled one
  { firstName: 'Jane', lastName: 'Doe', email: email('jane'), instrumentsPlayed: ['Keyboard', 'Voice'] },
  { firstName: 'Marco', lastName: 'Silva', email: email('marco'), instrumentsPlayed: ['Guitar'] },
  { firstName: 'Lena', lastName: 'Ford', email: email('lena'), instrumentsPlayed: ['Drums'] },
  { firstName: 'Tomas', lastName: 'Ruiz', email: email('tomas'), instrumentsPlayed: ['Bass', 'Guitar'] },
  { firstName: 'Aisha', lastName: 'Khan', email: email('aisha'), instrumentsPlayed: ['Saxophone'] },
  { firstName: 'Ben', lastName: 'Okafor', email: email('ben'), instrumentsPlayed: ['Voice'] },
  { firstName: 'Nina', lastName: 'Vogel', email: email('nina'), instrumentsPlayed: ['Keyboard'] },
  { firstName: 'Sam', lastName: 'Petit', email: email('sam'), instrumentsPlayed: ['Drums', 'Bass'] },
];

// ---------------------------------------------------------------------------------------------
// The rooms
// ---------------------------------------------------------------------------------------------

// `venueName` and `address` live on the session, not on the user, so a promoter can run nights in
// several rooms. Coordinates are only ever used to draw a map pin — the last room deliberately has
// none, so the client's "address as text, no map" fallback has something to render.
const rooms = [
  {
    venueName: 'KulturKellerei',
    address: { formatted: 'Königstraße 93, 90402 Nürnberg', lat: 49.4478, lng: 11.0797 },
  },
  {
    venueName: 'Blaues Zimmer',
    address: { formatted: 'Untere Kanalstraße 12, 90429 Nürnberg', lat: 49.4521, lng: 11.0533 },
  },
  {
    venueName: 'Hinterhof Bühne',
    address: { formatted: 'Oranienstraße 140, 10969 Berlin', lat: 52.5027, lng: 13.4142 },
  },
  {
    venueName: 'Alte Werkstatt',
    address: { formatted: 'Karl-Heine-Straße 51, 04229 Leipzig' },
  },
] as const;

// ---------------------------------------------------------------------------------------------
// The nights
// ---------------------------------------------------------------------------------------------

type SessionSeed = {
  venue: number;
  room: number;
  days: number;
  title: string;
  summary: string;
  startTime: string;
  endTime: string;
  slotDurationMinutes: number;
  instrumentTemplate: { instrument: string; spotsTotal: number }[];
  genres: string[];
  skillLevel: string[];
  cancelled?: boolean;
};

const sessionSeeds: SessionSeed[] = [
  {
    venue: 0,
    room: 0,
    days: 3,
    title: 'Wednesday Night Jam',
    summary: 'Open jam session for all instruments. House drum kit, bass amp and PA provided.',
    startTime: '20:00',
    endTime: '21:00',
    slotDurationMinutes: 15,
    instrumentTemplate: [
      { instrument: 'Guitar', spotsTotal: 3 },
      { instrument: 'Bass', spotsTotal: 1 },
      { instrument: 'Keyboard', spotsTotal: 1 },
      { instrument: 'Voice', spotsTotal: 2 },
      { instrument: 'Drums', spotsTotal: 1 },
    ],
    genres: ['jazz', 'funk', 'soul'],
    skillLevel: ['all-levels'],
  },
  {
    venue: 1,
    room: 1,
    days: 5,
    title: 'Blues Basement',
    summary: 'Slow blues and shuffles in a low-ceilinged room. Bring a slide if you have one.',
    startTime: '19:00',
    endTime: '22:00',
    slotDurationMinutes: 60,
    instrumentTemplate: [
      { instrument: 'Guitar', spotsTotal: 2 },
      { instrument: 'Harmonica', spotsTotal: 1 },
      { instrument: 'Bass', spotsTotal: 1 },
      { instrument: 'Drums', spotsTotal: 1 },
    ],
    genres: ['blues'],
    skillLevel: ['intermediate', 'advanced'],
  },
  {
    venue: 0,
    room: 0,
    days: 8,
    title: 'Funk Lab',
    summary: 'Groove-focused night. Short tight slots, one riff each, no long solos please.',
    startTime: '20:30',
    endTime: '22:30',
    slotDurationMinutes: 30,
    instrumentTemplate: [
      { instrument: 'Guitar', spotsTotal: 2 },
      { instrument: 'Bass', spotsTotal: 1 },
      { instrument: 'Keyboard', spotsTotal: 2 },
      { instrument: 'Drums', spotsTotal: 1 },
      { instrument: 'Voice', spotsTotal: 1 },
      { instrument: 'Saxophone', spotsTotal: 1 },
    ],
    genres: ['funk', 'soul'],
    skillLevel: ['intermediate'],
  },
  {
    venue: 2,
    room: 2,
    days: 10,
    title: 'Hinterhof Open Stage',
    summary: 'Courtyard stage, acoustic-leaning. Anyone can play, and anyone can just listen.',
    startTime: '19:30',
    endTime: '21:30',
    slotDurationMinutes: 30,
    instrumentTemplate: [
      { instrument: 'Guitar', spotsTotal: 2 },
      { instrument: 'Bass', spotsTotal: 1 },
      { instrument: 'Drums', spotsTotal: 1 },
      { instrument: 'Voice', spotsTotal: 2 },
    ],
    genres: ['folk', 'pop', 'rock'],
    skillLevel: ['beginner', 'intermediate'],
  },
  {
    venue: 1,
    room: 1,
    days: 12,
    title: 'Rained Off Session',
    summary: 'This one was called off — it exists so the cancelled state has something to show.',
    startTime: '20:00',
    endTime: '21:00',
    slotDurationMinutes: 30,
    instrumentTemplate: [
      { instrument: 'Guitar', spotsTotal: 2 },
      { instrument: 'Drums', spotsTotal: 1 },
    ],
    genres: ['rock'],
    skillLevel: ['all-levels'],
    cancelled: true,
  },
  {
    venue: 3,
    room: 3,
    days: 15,
    title: 'Werkstatt Jam',
    summary: 'Converted workshop with a concrete floor and a lot of natural reverb. Loud is fine.',
    startTime: '18:00',
    endTime: '21:00',
    slotDurationMinutes: 60,
    instrumentTemplate: [
      { instrument: 'Guitar', spotsTotal: 2 },
      { instrument: 'Bass', spotsTotal: 1 },
      { instrument: 'Drums', spotsTotal: 1 },
      { instrument: 'Keyboard', spotsTotal: 1 },
    ],
    genres: ['rock', 'metal'],
    skillLevel: ['intermediate', 'advanced'],
  },
  {
    venue: 0,
    room: 0,
    days: 17,
    title: 'Latin Night',
    summary: 'Son, salsa and a bit of bossa. Percussion especially welcome, congas provided.',
    startTime: '20:00',
    endTime: '22:00',
    slotDurationMinutes: 30,
    instrumentTemplate: [
      { instrument: 'Guitar', spotsTotal: 1 },
      { instrument: 'Bass', spotsTotal: 1 },
      { instrument: 'Percussion', spotsTotal: 3 },
      { instrument: 'Voice', spotsTotal: 1 },
      { instrument: 'Trumpet', spotsTotal: 1 },
    ],
    genres: ['latin'],
    skillLevel: ['all-levels'],
  },
  {
    venue: 2,
    room: 2,
    days: 19,
    title: 'Heavy Slot Night',
    summary: 'Down-tuned and unapologetic. One hour per line-up, full backline available.',
    startTime: '20:00',
    endTime: '23:00',
    slotDurationMinutes: 60,
    instrumentTemplate: [
      { instrument: 'Guitar', spotsTotal: 2 },
      { instrument: 'Bass', spotsTotal: 1 },
      { instrument: 'Drums', spotsTotal: 1 },
      { instrument: 'Voice', spotsTotal: 1 },
    ],
    genres: ['metal'],
    skillLevel: ['advanced'],
  },
  {
    venue: 1,
    room: 1,
    days: 22,
    title: 'Anything Goes',
    summary: 'No house style and no expectations. Fifteen minutes each, play whatever you brought.',
    startTime: '19:00',
    endTime: '21:00',
    slotDurationMinutes: 15,
    instrumentTemplate: [
      { instrument: 'Guitar', spotsTotal: 2 },
      { instrument: 'Bass', spotsTotal: 1 },
      { instrument: 'Keyboard', spotsTotal: 1 },
      { instrument: 'Drums', spotsTotal: 1 },
      { instrument: 'Voice', spotsTotal: 1 },
    ],
    // the catch-alls, so JS15 has something to match in the browse filters
    genres: ['all-genres'],
    skillLevel: ['all-levels'],
  },
  {
    venue: 3,
    room: 3,
    days: 26,
    title: 'Postponed Jam',
    summary: 'Also called off. Two cancelled sessions, so a filtered list of them is not a list of one.',
    startTime: '19:00',
    endTime: '20:00',
    slotDurationMinutes: 30,
    instrumentTemplate: [{ instrument: 'Guitar', spotsTotal: 2 }],
    genres: ['folk'],
    skillLevel: ['beginner'],
    cancelled: true,
  },
  {
    venue: 0,
    room: 0,
    days: 30,
    title: 'Soul & Jazz Standards',
    summary: 'Real Book night. Charts on the stands, one tune per slot, rhythm section supplied.',
    startTime: '20:00',
    endTime: '22:00',
    slotDurationMinutes: 60,
    instrumentTemplate: [
      { instrument: 'Guitar', spotsTotal: 1 },
      { instrument: 'Bass', spotsTotal: 1 },
      { instrument: 'Keyboard', spotsTotal: 1 },
      { instrument: 'Drums', spotsTotal: 1 },
      { instrument: 'Saxophone', spotsTotal: 2 },
      { instrument: 'Voice', spotsTotal: 1 },
    ],
    genres: ['jazz', 'soul'],
    skillLevel: ['intermediate', 'advanced'],
  },
  {
    venue: 2,
    room: 2,
    days: 34,
    title: 'Experimental Late',
    summary: 'Drones, loops and prepared instruments. Starts late and ends when it ends.',
    startTime: '22:00',
    endTime: '23:30',
    slotDurationMinutes: 30,
    instrumentTemplate: [
      { instrument: 'Guitar', spotsTotal: 1 },
      { instrument: 'Synthesizer', spotsTotal: 2 },
      { instrument: 'Percussion', spotsTotal: 1 },
    ],
    genres: ['experimental', 'electronic'],
    skillLevel: ['all-levels'],
  },
];

// ---------------------------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------------------------

await connectDB();

type SeededUser = InstanceType<typeof User>;
type SeededSession = InstanceType<typeof JamSession>;

// --- clear the previous run, and nothing else -------------------------------------------------

const previousUsers = await User.find({ email: new RegExp(`@${DEMO_DOMAIN}$`) }).select('_id');
const previousUserIds = previousUsers.map(({ _id }) => _id);

const previousSessions = await JamSession.find({ venueId: { $in: previousUserIds } }).select('_id');
const previousSessionIds = previousSessions.map(({ _id }) => _id);

const removedBookings = await Booking.deleteMany({
  $or: [{ jamSessionId: { $in: previousSessionIds } }, { musicianId: { $in: previousUserIds } }],
});
const removedSessions = await JamSession.deleteMany({ _id: { $in: previousSessionIds } });
const removedUsers = await User.deleteMany({ _id: { $in: previousUserIds } });

console.log(
  `\ncleared previous demo data: ${removedUsers.deletedCount} users, ` +
    `${removedSessions.deletedCount} jam sessions, ${removedBookings.deletedCount} bookings`,
);

// --- users -----------------------------------------------------------------------------------

// `User.create` one at a time rather than `insertMany`, because the password has to go through the
// `pre('save')` hook — `insertMany` skips document middleware and would store it in plain text,
// which would then silently fail every login attempt against these accounts.
const venues: SeededUser[] = [];

for (const person of venuePeople) {
  venues.push(await User.create({ ...person, password: DEMO_PASSWORD, role: 'venue' }));
}

const musicians: SeededUser[] = [];

for (const person of musicianPeople) {
  musicians.push(await User.create({ ...person, password: DEMO_PASSWORD, role: 'musician' }));
}

console.log(`created ${venues.length} venues and ${musicians.length} musicians`);

// --- jam sessions ----------------------------------------------------------------------------

const sessions: SeededSession[] = [];

for (const seed of sessionSeeds) {
  const room = must(rooms[seed.room], `unknown room ${seed.room}`);
  const venue = must(venues[seed.venue], `unknown venue ${seed.venue}`);

  const candidate = {
    title: seed.title,
    summary: seed.summary,
    date: inDays(seed.days),
    startTime: seed.startTime,
    endTime: seed.endTime,
    venueName: room.venueName,
    address: room.address,
    slotDurationMinutes: seed.slotDurationMinutes,
    instrumentTemplate: seed.instrumentTemplate,
    genres: seed.genres,
    skillLevel: seed.skillLevel,
  };

  // Through the same schema a real request goes through. Seed data that the API would have rejected
  // is worse than no seed data: it produces a client built against shapes the server cannot
  // actually return, and the mistake surfaces days later.
  const validated = jamSessionInputSchema.safeParse(candidate);

  if (!validated.success) {
    throw new Error(`seed session "${seed.title}" is invalid:\n${z.prettifyError(validated.error)}`);
  }

  sessions.push(
    await JamSession.create({
      ...validated.data,
      venueId: venue._id,
      date: dateStringToUtcMidnight(validated.data.date),
      // the same generator the controller uses, so seeded slots and real slots cannot differ
      slots: generateSlots(validated.data),
      ...(seed.cancelled ? { status: 'cancelled' } : {}),
    }),
  );
}

console.log(`created ${sessions.length} jam sessions`);

// --- bookings --------------------------------------------------------------------------------

// Mirrors `createBooking`: claim each spot atomically, then write the documents with the ids the
// claims reserved. Going through `claimSpot` rather than setting `bookingId` by hand is what keeps
// the seeded state indistinguishable from state the API produced.
const book = async ({
  session,
  slotIndex,
  musician,
  labels,
  bandName,
  cancelled = false,
}: {
  session: SeededSession;
  slotIndex: number;
  musician: SeededUser;
  labels: string[] | 'all';
  bandName?: string;
  cancelled?: boolean;
}) => {
  const slot = must(session.slots[slotIndex], `session "${session.title}" has no slot ${slotIndex}`);
  const spots = labels === 'all' ? [...slot.spots] : slot.spots.filter((s) => labels.includes(s.label));

  if (spots.length === 0) throw new Error(`no spots matched ${JSON.stringify(labels)}`);

  const groupId = randomUUID();
  const qrCode = randomUUID();
  const pending = [];

  for (const spot of spots) {
    const bookingId = new Types.ObjectId();
    const claimed = await claimSpot({
      jamSessionId: session._id.toString(),
      slotId: slot.slotId,
      spotId: spot.spotId,
      bookingId,
    });

    if (!claimed) throw new Error(`could not claim "${spot.label}" in "${session.title}"`);

    pending.push({
      _id: bookingId,
      groupId,
      qrCode,
      jamSessionId: session._id,
      slotId: slot.slotId,
      spotId: spot.spotId,
      musicianId: musician._id,
      ...claimed,
      ...(bandName ? { bandName } : {}),
    });
  }

  const created = await Booking.insertMany(pending);

  // Cancelled the way the endpoint cancels: mark the document, then free the spot. It leaves a
  // booking in the history and a spot back on the board, which is the pair of states the client
  // has to handle together.
  if (cancelled) {
    for (const booking of created) {
      booking.set({ status: 'cancelled' });
      await booking.save();
      await releaseSpot({
        jamSessionId: String(booking.jamSessionId),
        slotId: booking.slotId,
        spotId: booking.spotId,
        bookingId: booking._id,
      });
    }
  }

  return created;
};

const jane = must(musicians[0], 'no musicians seeded');
const wednesday = must(sessions[0], 'no sessions seeded');
const blues = must(sessions[1], 'no blues session');
const hinterhof = must(sessions[3], 'no hinterhof session');
const anythingGoes = must(sessions[8], 'no anything-goes session');

// A slot with nothing left, so the client has a sold-out state to build. Split across four
// musicians, because one person holding all eight spots is not a thing that happens.
await book({ session: wednesday, slotIndex: 0, musician: jane, labels: ['Keyboard', 'First Voice'] });
await book({
  session: wednesday,
  slotIndex: 0,
  musician: must(musicians[1], 'no musician 1'),
  labels: ['First Guitar', 'Second Guitar', 'Third Guitar'],
});
await book({
  session: wednesday,
  slotIndex: 0,
  musician: must(musicians[2], 'no musician 2'),
  labels: ['Drums', 'Second Voice'],
});
await book({
  session: wednesday,
  slotIndex: 0,
  musician: must(musicians[3], 'no musician 3'),
  labels: ['Bass'],
});

// A band: several spots, one submission, one groupId and one QR code — the multi-spot card.
await book({
  session: wednesday,
  slotIndex: 1,
  musician: jane,
  labels: ['First Guitar', 'Bass', 'Drums'],
  bandName: 'The Nightowls',
});

// Partly booked, which is the ordinary case and the one the slot picker spends its life rendering.
await book({
  session: wednesday,
  slotIndex: 2,
  musician: must(musicians[4], 'no musician 4'),
  labels: ['First Guitar'],
});
await book({
  session: wednesday,
  slotIndex: 2,
  musician: must(musicians[5], 'no musician 5'),
  labels: ['Drums'],
});

await book({ session: blues, slotIndex: 0, musician: jane, labels: ['Harmonica'] });
await book({
  session: blues,
  slotIndex: 0,
  musician: must(musicians[6], 'no musician 6'),
  labels: ['First Guitar'],
});

// Jane's cancelled booking, so her history is not uniformly confirmed.
await book({ session: blues, slotIndex: 1, musician: jane, labels: ['Drums'], cancelled: true });

await book({ session: hinterhof, slotIndex: 1, musician: jane, labels: ['First Voice'] });
await book({
  session: hinterhof,
  slotIndex: 1,
  musician: must(musicians[7], 'no musician 7'),
  labels: ['First Guitar', 'Bass'],
  bandName: 'Two Thirds',
});

await book({
  session: anythingGoes,
  slotIndex: 0,
  musician: must(musicians[2], 'no musician 2'),
  labels: ['Keyboard'],
});

const bookingCount = await Booking.countDocuments({ musicianId: { $in: musicians.map((m) => m._id) } });
const janeBookings = await Booking.countDocuments({ musicianId: jane._id });

// ---------------------------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------------------------

console.log(`created ${bookingCount} bookings (${janeBookings} of them Jane's)\n`);
console.log(`all accounts share the password: ${DEMO_PASSWORD}\n`);
console.log('  venues');
for (const venue of venues) console.log(`    ${venue.email}`);
console.log('  musicians');
for (const musician of musicians) {
  console.log(`    ${musician.email}${musician._id.equals(jane._id) ? '   <- has bookings' : ''}`);
}
console.log(`\n  sessions run from ${inDays(3)} to ${inDays(34)}`);
console.log(`  "${wednesday.title}" on ${inDays(3)}: slot 1 is full, slot 3 is partly booked\n`);

await mongoose.disconnect();
