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

/* The offset of the first day on or after `days` that falls on `weekday`.
 *
 * The schedule below is written as offsets from whenever the seed is run, which is what keeps it
 * from going stale — but it also means a fixture cannot know which weekday it will land on. For
 * most nights that does not matter. For the three whose title names a day, it is the difference
 * between data that reads as real and data that reads as generated. */
const onWeekday = (days: number, weekday: number): number => {
  const landsOn = new Date(dateStringToUtcMidnight(inDays(days))).getUTCDay();

  return days + ((weekday - landsOn + 7) % 7);
};

/* Nobody runs a jam night on Christmas Eve, Christmas Day or Boxing Day. A week later keeps the
   weekday — and therefore any promise the title made — intact. */
const avoidHolidays = (days: number): number =>
  ['12-24', '12-25', '12-26'].includes(inDays(days).slice(5)) ? days + 7 : days;

/* The date a scheduled entry actually runs on, after both rules above.
 *
 * Neither is applied to a fixture dated today or earlier. Those four exist to put the venue's board into
   states the wizard cannot create — two nights played, one called off, one running right now — and
   "running right now" is a promise about the date that outranks any promise the title makes about
   the weekday. Snapping `days: 0` forward is how the one session happening today became one
   happening tomorrow. */
const dayOffset = (entry: { days: number }, night: { weekday?: number }): number =>
  entry.days <= 0
    ? entry.days
    : avoidHolidays(night.weekday === undefined ? entry.days : onWeekday(entry.days, night.weekday));

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
// several rooms. Coordinates are only ever used to draw a map pin — `Alte Werkstatt` deliberately
// has none, so the client's 'address as text, no map' fallback has something to render.
//
// City names are English where the app's own data already uses them (Munich, not München). The
// browse's city filter parses these strings back out of the address line, so 'Munich' and
// 'München' would sit in the dropdown as two different options for one city.
const rooms = [
  {
    venueName: 'KulturKellerei',
    address: {
      formatted: 'Königstraße 93, 90402 Nuremberg',
      lat: 49.4478,
      lng: 11.0797,
    },
  },
  {
    venueName: 'Blaues Zimmer',
    address: {
      formatted: 'Untere Kanalstraße 12, 90429 Nuremberg',
      lat: 49.4521,
      lng: 11.0533,
    },
  },
  {
    venueName: 'Hinterhof Bühne',
    address: {
      formatted: 'Oranienstraße 140, 10969 Berlin',
      lat: 52.5027,
      lng: 13.4142,
    },
  },
  {
    venueName: 'Alte Werkstatt',
    address: { formatted: 'Karl-Heine-Straße 51, 04229 Leipzig' },
  },
  {
    venueName: 'Hafenklang Salon',
    address: {
      formatted: 'Große Elbstraße 84, 22767 Hamburg',
      lat: 53.5461,
      lng: 9.9375,
    },
  },
  {
    venueName: 'Sudhaus 7',
    address: {
      formatted: 'Venloer Straße 40, 50672 Cologne',
      lat: 50.9445,
      lng: 6.9317,
    },
  },
  {
    venueName: 'Glockenbach Stube',
    address: {
      formatted: 'Reichenbachstraße 29, 80469 Munich',
      lat: 48.1291,
      lng: 11.5754,
    },
  },
  {
    venueName: 'Neustadt Tonstudio',
    address: {
      formatted: 'Alaunstraße 36, 01099 Dresden',
      lat: 51.0635,
      lng: 13.753,
    },
  },
] as const;

// ---------------------------------------------------------------------------------------------
// The nights
// ---------------------------------------------------------------------------------------------

/* A recurring night, described once and run on several dates.
 *
 * Venues run regulars — a monthly blues night, a weekly open mic — so this is what the real thing
 * looks like, and it buys two things a flat list of one-off fixtures doesn't. The board reads like
 * a platform with residents rather than forty unrelated events, and each night needs exactly one
 * photograph: `image` belongs to the concept, so every instance of 'Late Night Jazz Corner' shows
 * the same jazz corner. Twenty photographs cover forty sessions with no repeat ever landing twice
 * on one page of the browse — see the schedule below for how that is arranged rather than hoped for.
 */
type NightConcept = {
  venue: number;
  room: number;
  title: string;
  summary: string;
  /* The day of the week this night runs on, 0 = Sunday. Only the nights whose *name* promises one
     set it — "Open Mic Tuesday" landing on a Monday is the kind of detail that makes seeded data
     read as seeded. The rest are left free so the calendar spreads across the whole week. */
  weekday?: number;
  // A Cloudinary delivery URL. Pinned to that host by `jamSessionInputSchema`, which these go
  // through like everything else here.
  image: string;
  // Markdown, stored as a single overview block. The client renders it with react-markdown, so the
  // bullet lists below arrive as lists rather than as literal asterisks.
  overview: string;
  startTime: string;
  endTime: string;
  slotDurationMinutes: number;
  instrumentTemplate: { instrument: string; spotsTotal: number }[];
  genres: string[];
  skillLevel: string[];
};

const CLOUDINARY = 'https://res.cloudinary.com/w1a1xo6n/image/upload';

const nights: NightConcept[] = [
  {
    venue: 1,
    room: 2,
    title: 'Modern Rock Night',
    summary:
      'Loud, driving rock from the 1990s onward, played on proper club gear. Bring your guitar — the house backline covers everything else.',
    image: `${CLOUDINARY}/v1787494893/modern-rock-night_e2rvq6.png`,
    overview: `If you want to play music that packs a punch from the 1990s onward, bring your gear and join us for a night centered around modern rock and alternative. We are rolling out a setlist of heavy, driving tracks ranging from grunge and hard rock to contemporary alt-rock, played loud on proper club gear.

Featured artists and bands:

* Nirvana
* Foo Fighters
* Linkin Park
* Three Days Grace
* Papa Roach
* Halestorm
* Skillet
* Volbeat
* Muse
* Nothing But Thieves

The stage takes a full band. House drum kit, two guitar amps, a bass rig and a five-piece PA are all here — turn up with an instrument and a cable.`,
    startTime: '20:00',
    endTime: '23:00',
    slotDurationMinutes: 30,
    instrumentTemplate: [
      { instrument: 'Guitar', spotsTotal: 3 },
      { instrument: 'Bass', spotsTotal: 1 },
      { instrument: 'Drums', spotsTotal: 1 },
      { instrument: 'Voice', spotsTotal: 2 },
      { instrument: 'Keyboard', spotsTotal: 1 },
    ],
    genres: ['rock'],
    skillLevel: ['all-levels'],
  },
  {
    venue: 0,
    room: 0,
    title: 'Blue Monday Blues Jam',
    weekday: 1,
    summary:
      'Twelve bars, a shuffle and a room that knows the changes. Standards everyone can fall into without a rehearsal.',
    image: `${CLOUDINARY}/v1787495011/Blue-Monday-Blues-Jam_l96s31.png`,
    overview: `The oldest night in the Kellerei calendar and the easiest one to walk into. We stay on the standards, mostly in A and E, so nobody needs a chart and nobody needs a rehearsal — call the key, count it in, play.

Usual territory:

* Muddy Waters
* Howlin' Wolf
* Freddie King
* Albert Collins
* Stevie Ray Vaughan
* Bonnie Raitt

Harmonica players, this is your night — there is one harp spot per slot and it goes fast. The house keeps a Fender Blues Junior and a small kit; everything else comes with you.`,
    startTime: '19:30',
    endTime: '22:30',
    slotDurationMinutes: 30,
    instrumentTemplate: [
      { instrument: 'Guitar', spotsTotal: 2 },
      { instrument: 'Harmonica', spotsTotal: 1 },
      { instrument: 'Bass', spotsTotal: 1 },
      { instrument: 'Drums', spotsTotal: 1 },
      { instrument: 'Voice', spotsTotal: 1 },
      { instrument: 'Keyboard', spotsTotal: 1 },
    ],
    genres: ['blues'],
    skillLevel: ['all-levels'],
  },
  {
    venue: 2,
    room: 4,
    title: 'Late Night Jazz Corner',
    summary:
      'Small-group jazz in the back room. Real Book standards, called on the night, taken at whatever tempo the table agrees on.',
    image: `${CLOUDINARY}/v1787495312/Late-Night-Jazz-Corner_aqlucy.png`,
    overview: `A corner, four chairs and a set of standards. We call tunes on the night rather than publishing a list, which is the point — you should be able to sit down with people you have never played with and get through a head, some solos and a head out.

Expect the usual repertoire: Autumn Leaves, Blue Bossa, All The Things You Are, Take The A Train, So What. If you can read a lead sheet you will be fine.

There is an upright piano in the room and a bass amp. Horns and sticks come with you. This one runs late and the last slot often turns into everybody at once.`,
    startTime: '20:30',
    endTime: '23:30',
    slotDurationMinutes: 30,
    instrumentTemplate: [
      { instrument: 'Saxophone', spotsTotal: 2 },
      { instrument: 'Trumpet', spotsTotal: 1 },
      { instrument: 'Double Bass', spotsTotal: 1 },
      { instrument: 'Drums', spotsTotal: 1 },
      { instrument: 'Piano', spotsTotal: 1 },
      { instrument: 'Guitar', spotsTotal: 1 },
    ],
    genres: ['jazz'],
    skillLevel: ['intermediate', 'advanced'],
  },
  {
    venue: 1,
    room: 3,
    title: 'Acoustic Living Room',
    summary:
      'Sofas, a rug and no amplification at all. Folk, singer-songwriter material and whatever you have been working on at home.',
    image: `${CLOUDINARY}/v1787495648/Acoustic-Living-Room_pfxwjr.png`,
    overview: `Nothing is plugged in. We push the sofas into a circle, the audience sits on the floor and the loudest thing in the room is a cajón. It is the gentlest way into playing in front of people that this city has.

Bring anything quiet — guitar, voice, violin, flute, a ukulele you are still learning. Half-finished songs are welcome and so are covers.

One request: keep it to two pieces so everybody gets round. If the room is small that evening we simply go round twice.`,
    startTime: '18:00',
    endTime: '20:00',
    slotDurationMinutes: 30,
    instrumentTemplate: [
      { instrument: 'Guitar', spotsTotal: 3 },
      { instrument: 'Voice', spotsTotal: 3 },
      { instrument: 'Violin', spotsTotal: 1 },
      { instrument: 'Cajón', spotsTotal: 1 },
    ],
    genres: ['folk'],
    skillLevel: ['beginner', 'intermediate'],
  },
  {
    venue: 2,
    room: 5,
    title: 'Funk & Soul Revue',
    summary:
      'Tight grooves, a horn section and a rhythm section that locks. If you can hold a pocket for eight minutes, this is your night.',
    image: `${CLOUDINARY}/v1787495674/Funk-_-Soul-Revue_wieqmo.png`,
    overview: `A groove night, and a demanding one. The rhythm section sets a pocket and holds it — the fun is in what everybody builds on top, not in how fast anyone can play.

On the setlist most weeks:

* James Brown
* Sly & The Family Stone
* The Meters
* Tower of Power
* Cory Wong
* Vulfpeck

Horn players get two spots a slot and they are the first to go. The house has a Rhodes, a bass rig and a kit. Charts are on the music stands from 19:30 if you want a look before it starts.`,
    startTime: '20:00',
    endTime: '23:00',
    slotDurationMinutes: 45,
    instrumentTemplate: [
      { instrument: 'Guitar', spotsTotal: 2 },
      { instrument: 'Bass', spotsTotal: 1 },
      { instrument: 'Drums', spotsTotal: 1 },
      { instrument: 'Keyboard', spotsTotal: 1 },
      { instrument: 'Trumpet', spotsTotal: 1 },
      { instrument: 'Saxophone', spotsTotal: 1 },
      { instrument: 'Voice', spotsTotal: 2 },
    ],
    genres: ['funk', 'soul'],
    skillLevel: ['intermediate', 'advanced'],
  },
  {
    venue: 3,
    room: 6,
    title: 'Open Mic Tuesday',
    weekday: 2,
    summary:
      'One microphone, fifteen minutes each, any genre at all. The oldest open mic in the Glockenbach and the friendliest room to fail in.',
    image: `${CLOUDINARY}/v1787495690/Open-Mic-Tuesday_tymcgp.png`,
    overview: `Fifteen minutes, one stage, anything you like. Songwriters, comedians who can also sing, a poet with a loop pedal — it has all happened here and it all counts.

The room holds about sixty and they listen properly, which is rarer than it sounds. There is a PA, one vocal mic, a DI for an acoustic guitar and an upright piano against the wall.

New to playing live? Take an early slot. The room fills as the night goes on, and the 19:00 slot in front of twenty people is a much kinder first time than the 21:30 one.`,
    startTime: '19:00',
    endTime: '22:00',
    slotDurationMinutes: 15,
    instrumentTemplate: [
      { instrument: 'Voice', spotsTotal: 1 },
      { instrument: 'Guitar', spotsTotal: 1 },
      { instrument: 'Keyboard', spotsTotal: 1 },
    ],
    genres: ['all-genres'],
    skillLevel: ['all-levels'],
  },
  {
    venue: 3,
    room: 7,
    title: 'Synth & Circuit Lab',
    summary:
      'Patch cables, drum machines and no guitars. Bring a box that makes a noise and we will find it a place in the mix.',
    image: `${CLOUDINARY}/v1787496134/Synth-_-Circuit-Lab_kwrieb.png`,
    overview: `An electronic jam, which mostly means a table, a lot of cables and a shared clock. Everything syncs over MIDI from the house rig, so bring anything that takes a clock and we will get it in time with the rest.

What tends to turn up:

* Modular racks, small and enormous
* Elektron boxes
* Volcas and other small groove machines
* Laptops running Ableton
* One brave person with a theremin

There is a powered mixer with eight channels, DI boxes and plenty of sockets. No guitars on this night — there is a whole other evening for that.`,
    startTime: '19:00',
    endTime: '22:00',
    slotDurationMinutes: 30,
    instrumentTemplate: [
      { instrument: 'Synthesizer', spotsTotal: 3 },
      { instrument: 'Drum Machine', spotsTotal: 2 },
      { instrument: 'Laptop', spotsTotal: 2 },
      { instrument: 'Modular Rig', spotsTotal: 1 },
    ],
    genres: ['electronic', 'experimental'],
    skillLevel: ['all-levels'],
  },
  {
    venue: 0,
    room: 1,
    title: 'Metal Garage Session',
    summary:
      'Down-tuned, loud and unapologetic. A rehearsal room with a PA, run as a jam — riffs welcome, solos optional.',
    image: `${CLOUDINARY}/v1787496152/Metal-Garage-Session_ri0oez.png`,
    overview: `Two 4x12 cabinets, a double-kick pedal and a room with no neighbours to annoy. We run this as a proper jam rather than a showcase: somebody starts a riff, everybody else finds their place in it.

Common ground on the night:

* Metallica
* Pantera
* Gojira
* Mastodon
* Lamb of God
* Trivium

Drop tunings are the norm, so bring a tuner and a spare set of strings. Ear protection is on the bar and it is free — please take some.`,
    startTime: '20:00',
    endTime: '23:00',
    slotDurationMinutes: 30,
    instrumentTemplate: [
      { instrument: 'Guitar', spotsTotal: 3 },
      { instrument: 'Bass', spotsTotal: 1 },
      { instrument: 'Drums', spotsTotal: 1 },
      { instrument: 'Voice', spotsTotal: 1 },
    ],
    genres: ['metal'],
    skillLevel: ['intermediate', 'advanced'],
  },
  {
    venue: 1,
    room: 2,
    title: 'Latin Groove Night',
    summary:
      'Son, salsa and Latin jazz with a full percussion front line. Clave first, everything else after.',
    image: `${CLOUDINARY}/v1787496541/Latin-Groove-Night_v5ursj.jpg`,
    overview: `Everything on this night sits on the clave, and if you have not played inside one before this is a good place to learn — the percussion players are patient and they will count it with you.

We work through son montuno, salsa dura and a bit of Latin jazz. Two congas, timbales and a bell are here in the room; bring your own if you prefer your heads.

Repertoire leans on Buena Vista Social Club, Tito Puente, Eddie Palmieri and a few Rubén Blades tunes that everybody seems to know the words to by the second chorus.`,
    startTime: '20:00',
    endTime: '22:30',
    slotDurationMinutes: 30,
    instrumentTemplate: [
      { instrument: 'Congas', spotsTotal: 2 },
      { instrument: 'Timbales', spotsTotal: 1 },
      { instrument: 'Bass', spotsTotal: 1 },
      { instrument: 'Guitar', spotsTotal: 2 },
      { instrument: 'Piano', spotsTotal: 1 },
      { instrument: 'Trumpet', spotsTotal: 1 },
      { instrument: 'Voice', spotsTotal: 1 },
    ],
    genres: ['latin'],
    skillLevel: ['all-levels'],
  },
  {
    venue: 2,
    room: 4,
    title: 'Reggae Sunset Session',
    summary:
      'On the terrace while the light goes, one drop all evening. The most relaxed three hours on the Elbe.',
    image: `${CLOUDINARY}/v1787496864/Reggae-Sunset-Session_thss3n.jpg`,
    overview: `Outdoors on the terrace from six, facing west, which is the entire reason this night starts when it does. We play through the sunset and finish as the lights come on across the water.

One drop, rocksteady and a bit of dub. Nothing here is fast and nothing here is complicated — the skill is in leaving space, which is harder than it sounds and is why the night is worth playing.

If it rains we move inside and carry on. There is a keyboard, a bass rig and a kit under cover either way.`,
    startTime: '18:00',
    endTime: '21:00',
    slotDurationMinutes: 30,
    instrumentTemplate: [
      { instrument: 'Guitar', spotsTotal: 2 },
      { instrument: 'Bass', spotsTotal: 1 },
      { instrument: 'Drums', spotsTotal: 1 },
      { instrument: 'Keyboard', spotsTotal: 1 },
      { instrument: 'Voice', spotsTotal: 2 },
      { instrument: 'Percussion', spotsTotal: 1 },
    ],
    genres: ['reggae'],
    skillLevel: ['all-levels'],
  },
  {
    venue: 1,
    room: 2,
    title: 'Hip-Hop Cypher & Beats',
    summary:
      'Open cypher over live beats. Four mics a round, no written verses required and no pressure to go twice.',
    image: `${CLOUDINARY}/v1787496872/Hip-Hop-Cypher-_-Beats_v9iafr.jpg`,
    overview: `A cypher, run properly: four mics, a beat from the booth and everybody in a circle rather than facing a stage. You go when you are ready and you can pass.

Beatmakers get a spot too — bring an MPC, a laptop or a controller and take a turn supplying the instrumental. The house runs a two-channel mixer into the PA with a DI for whatever you bring.

Freestyle and written both welcome. English and German both normal here, and most nights somebody switches between them mid-verse.`,
    startTime: '20:00',
    endTime: '22:00',
    slotDurationMinutes: 15,
    instrumentTemplate: [
      { instrument: 'MC', spotsTotal: 4 },
      { instrument: 'Turntables', spotsTotal: 1 },
      { instrument: 'Sampler', spotsTotal: 1 },
      { instrument: 'Bass', spotsTotal: 1 },
    ],
    genres: ['hip-hop'],
    skillLevel: ['all-levels'],
  },
  {
    venue: 3,
    room: 6,
    title: 'Piano Bar Standards',
    summary:
      'A piano, a singer and a room that goes quiet for the verse. Great American Songbook, played close to the original.',
    image: `${CLOUDINARY}/v1787496994/Piano-Bar-Standards_k96zwd.jpg`,
    overview: `The Songbook, played straight. This is not the night for reharmonising everything into 7/8 — the pleasure here is in the tune, the lyric and a room that actually listens to the verse.

Singers are the centre of it and there are two vocal spots a slot. Pianists, you will accompany as much as you solo, so come prepared to follow a key change called from the microphone.

Cole Porter, Gershwin, Rodgers & Hart, a bit of Jobim when it gets late. The upright is tuned monthly and there is a bass amp behind it.`,
    startTime: '19:30',
    endTime: '22:30',
    slotDurationMinutes: 30,
    instrumentTemplate: [
      { instrument: 'Piano', spotsTotal: 1 },
      { instrument: 'Voice', spotsTotal: 2 },
      { instrument: 'Double Bass', spotsTotal: 1 },
      { instrument: 'Saxophone', spotsTotal: 1 },
      { instrument: 'Drums', spotsTotal: 1 },
    ],
    genres: ['jazz'],
    skillLevel: ['intermediate', 'advanced'],
  },
  {
    venue: 1,
    room: 3,
    title: 'Beginners Welcome Jam',
    summary:
      'For people who have never played with other people. Three chords, a slow count and nobody watching from the bar.',
    image: `${CLOUDINARY}/v1787497064/Beginners-Welcome-Jam_j1qvch.jpg`,
    overview: `If you have only ever played alone in your room, this night exists for you. It runs in the afternoon, the doors stay shut, and there is no audience — just the people playing.

How it works: we agree on three chords, somebody counts it in slowly, and we keep going until it falls apart. Then we do it again. That is the whole format and it works.

There is a house guitar and a bass you can borrow if you do not own one yet. Ask at the door.

The only rule is that nobody comments on anybody else's playing unless they are asked to.`,
    startTime: '17:00',
    endTime: '19:00',
    slotDurationMinutes: 20,
    instrumentTemplate: [
      { instrument: 'Guitar', spotsTotal: 2 },
      { instrument: 'Bass', spotsTotal: 1 },
      { instrument: 'Drums', spotsTotal: 1 },
      { instrument: 'Keyboard', spotsTotal: 1 },
      { instrument: 'Voice', spotsTotal: 2 },
    ],
    genres: ['all-genres'],
    skillLevel: ['beginner'],
  },
  {
    venue: 2,
    room: 5,
    title: 'Drum Circle & Percussion',
    summary:
      'Hand drums in a circle, no melody instruments and no leader. Two hours of rhythm and nothing else.',
    image: `${CLOUDINARY}/v1787497153/Drum-Circle-_-Percussion_umljtf.jpg`,
    overview: `A circle, ten pairs of hands and no leader. Somebody starts something, it goes round, it changes, nobody is quite sure who changed it. Two hours goes very quickly.

There are djembes, congas, a cajón or two and a box of shakers, bells and blocks by the door — take whatever you like. If you own a drum you love, bring it.

No melody instruments on this night. It is not a rule about taste, it is that the moment a guitar appears everybody starts accompanying it instead of listening to each other.`,
    startTime: '18:30',
    endTime: '20:30',
    slotDurationMinutes: 30,
    instrumentTemplate: [
      { instrument: 'Djembe', spotsTotal: 4 },
      { instrument: 'Cajón', spotsTotal: 2 },
      { instrument: 'Congas', spotsTotal: 2 },
      { instrument: 'Shakers', spotsTotal: 2 },
    ],
    genres: ['experimental'],
    skillLevel: ['all-levels'],
  },
  {
    venue: 3,
    room: 7,
    title: '90s Alternative Throwback',
    summary:
      'Flannel optional. Grunge, Britpop and everything the alternative charts held between 1991 and 1999.',
    image: `${CLOUDINARY}/v1787497206/90s-Alternative-Throwback_du7drf.jpg`,
    overview: `One decade, played loud. If you learned guitar from a tab site around 1997, you already know the entire setlist.

The decade in question:

* Nirvana
* Pearl Jam
* Smashing Pumpkins
* Oasis
* Blur
* Radiohead
* Weezer
* Alanis Morissette
* The Cranberries
* Garbage

Two guitar amps, a bass rig and a kit are here. A chorus pedal is provided free of charge and using it is strongly encouraged.`,
    startTime: '20:00',
    endTime: '23:00',
    slotDurationMinutes: 30,
    instrumentTemplate: [
      { instrument: 'Guitar', spotsTotal: 3 },
      { instrument: 'Bass', spotsTotal: 1 },
      { instrument: 'Drums', spotsTotal: 1 },
      { instrument: 'Voice', spotsTotal: 2 },
    ],
    genres: ['rock'],
    skillLevel: ['all-levels'],
  },
  {
    venue: 3,
    room: 6,
    title: 'Singer-Songwriter Round',
    summary:
      'Three writers in the round, trading songs and the stories behind them. Originals strongly preferred.',
    image: `${CLOUDINARY}/v1787497282/Singer-Songwriter-Round_m6dc1x.jpg`,
    overview: `Nashville format: three chairs facing each other rather than facing out, and the writers take turns. You play one, the person on your left plays one, round and round.

Say something about the song before you play it. That is the part people come for, and it is what makes this different from an open mic.

Originals strongly preferred. A cover is fine if it means something to you and you say why.

There is a house guitar tuned to standard, a keyboard and two vocal mics. Harmonising on somebody else's chorus is not only allowed, it is the best thing that happens here.`,
    startTime: '19:00',
    endTime: '21:00',
    slotDurationMinutes: 20,
    instrumentTemplate: [
      { instrument: 'Guitar', spotsTotal: 3 },
      { instrument: 'Voice', spotsTotal: 3 },
      { instrument: 'Keyboard', spotsTotal: 1 },
    ],
    genres: ['folk', 'pop'],
    skillLevel: ['all-levels'],
  },
  {
    venue: 2,
    room: 4,
    title: 'Big Band Brass Blowout',
    summary:
      'A full horn section, charts on stands and one hour per set. Reading ability genuinely required.',
    image: `${CLOUDINARY}/v1787497337/Big-Band-Brass-Blowout_xrdswy.jpg`,
    overview: `The most demanding night on this calendar and the only one with a real prerequisite: you need to read. Charts go on the stands at 18:45 and the first set starts at 19:00 whether or not everybody has looked at them.

Eleven spots, arranged as a proper section — four trumpets, three trombones, four saxes, plus rhythm. Sets are an hour, which is why there are only three of them.

Basie, Ellington, Thad Jones, a couple of Gordon Goodwin charts when the section is strong enough. Mutes are useful; bring them if you have them.`,
    startTime: '19:00',
    endTime: '22:00',
    slotDurationMinutes: 60,
    instrumentTemplate: [
      { instrument: 'Trumpet', spotsTotal: 4 },
      { instrument: 'Trombone', spotsTotal: 3 },
      { instrument: 'Saxophone', spotsTotal: 4 },
      { instrument: 'Double Bass', spotsTotal: 1 },
      { instrument: 'Drums', spotsTotal: 1 },
      { instrument: 'Piano', spotsTotal: 1 },
    ],
    genres: ['jazz'],
    skillLevel: ['advanced'],
  },
  {
    venue: 0,
    room: 0,
    title: 'Electric Blues Rock Night',
    summary:
      'Where the blues night goes when it plugs in. Tube amps, long solos and a rhythm section that can take it.',
    image: `${CLOUDINARY}/v1787497416/Electric-Blues-Rock-Night_y8ol4l.jpg`,
    overview: `The louder cousin of Blue Monday. Same room, same changes, considerably more gain.

Territory:

* Stevie Ray Vaughan
* Gary Moore
* Joe Bonamassa
* The Black Keys
* Rival Sons
* Gary Clark Jr.

Three guitar spots a slot, which sounds like a lot until you realise the whole point is trading choruses. Take four bars, hand it on.

Two tube amps in the room — a Blues Junior and a Deluxe Reverb. Bring pedals if you use them; there is a power strip on stage.`,
    startTime: '20:00',
    endTime: '22:30',
    slotDurationMinutes: 30,
    instrumentTemplate: [
      { instrument: 'Guitar', spotsTotal: 3 },
      { instrument: 'Bass', spotsTotal: 1 },
      { instrument: 'Drums', spotsTotal: 1 },
      { instrument: 'Voice', spotsTotal: 1 },
      { instrument: 'Harmonica', spotsTotal: 1 },
      { instrument: 'Keyboard', spotsTotal: 1 },
    ],
    genres: ['blues', 'rock'],
    skillLevel: ['all-levels'],
  },
  {
    venue: 1,
    room: 2,
    title: 'DJ Booth & Live Loops',
    summary:
      'Thirty minutes in the booth, back to back. Vinyl, controller or a laptop full of stems — all the same to us.',
    image: `${CLOUDINARY}/v1787497471/DJ-Booth-_-Live-Loops_pospi1.jpg`,
    overview: `Half an hour each, back to back, with a proper booth and a system that can take it. Not a competition and not a showcase — the good nights are the ones where two people end up playing at once.

The booth has two turntables, a four-channel mixer, a CDJ pair and spare inputs for whatever you bring. There is a send for anyone wanting to run effects.

House, techno, breaks, whatever the previous person left the room in the mood for. If you are mixing live loops rather than tracks, say so when you book so we can give you the longer slot.`,
    startTime: '21:00',
    endTime: '23:30',
    slotDurationMinutes: 30,
    instrumentTemplate: [
      { instrument: 'Turntables', spotsTotal: 2 },
      { instrument: 'Controller', spotsTotal: 2 },
      { instrument: 'Synthesizer', spotsTotal: 2 },
      { instrument: 'Sampler', spotsTotal: 1 },
    ],
    genres: ['electronic'],
    skillLevel: ['all-levels'],
  },
  {
    venue: 1,
    room: 3,
    title: 'Sunday Afternoon Slow Jam',
    weekday: 0,
    summary:
      'Daylight, coffee and no hurry. Whatever the room feels like playing, taken at half the usual tempo.',
    image: `${CLOUDINARY}/v1787497580/Sunday-Afternoon-Slow_-am_ncjdx9.jpg`,
    overview: `The gentlest thing in the calendar. Sunday afternoon, big windows, coffee on the side table, and a firm agreement that nothing gets counted in faster than it needs to be.

No fixed genre. Some weeks it is a soul groove for an hour, some weeks it is three people quietly working out a Radiohead tune. Whatever the room brings.

Everything is here — kit, bass rig, keyboard, two guitar amps and a small PA. Children are welcome and several regulars bring theirs.

If you have had a bad week, this is the one to come to.`,
    startTime: '15:00',
    endTime: '18:00',
    slotDurationMinutes: 30,
    instrumentTemplate: [
      { instrument: 'Guitar', spotsTotal: 2 },
      { instrument: 'Bass', spotsTotal: 1 },
      { instrument: 'Drums', spotsTotal: 1 },
      { instrument: 'Keyboard', spotsTotal: 1 },
      { instrument: 'Voice', spotsTotal: 2 },
      { instrument: 'Saxophone', spotsTotal: 1 },
    ],
    genres: ['all-genres'],
    skillLevel: ['all-levels'],
  },
];

/* When each night runs. One entry per session created.
 *
 * `night` indexes `nights` above; `days` is an offset from today, so the whole calendar moves with
 * the day the seed is run and nothing here goes stale.
 *
 * Two things are arranged rather than left to chance:
 *
 * The dates are weighted towards the end of the year — three in August against twelve in December —
 * because a flat spread empties out. Every session drops off the public browse the day after it
 * runs, so an even calendar means a full board today and a nearly empty one by November. Loading
 * the far end keeps roughly three pages standing into late autumn.
 *
 * And the nights cycle in a fixed order, so entry N is always `nights[N % 20]`. The browse shows
 * eight sessions to a page in date order, so two instances of one night are always twenty positions
 * apart — a page can never show the same title, or the same photograph, twice.
 */
type ScheduledNight = {
  night: number;
  days: number;
  cancelled?: boolean;
  /* A stable handle for the bookings at the bottom of this file to grab.
   *
   * It was a title lookup, and it can't be any more: recurring nights mean titles repeat, so
   * `find(title === 'Blue Monday Blues Jam')` silently returns whichever instance was created
   * first. That is the same class of bug as the positional indexes this replaced — the booking
   * lands on the wrong night and the error, if any, surfaces somewhere else entirely. */
  ref?: string;
};

const schedule: ScheduledNight[] = [
  // --- the venue board's own states, which the public browse never shows -----------------------
  // Two nights already played, one called off, one happening today. All four belong to venue 0, so
  // ana@ohjamming.demo alone shows every state the backstage board can render. `days <= 0` is the
  // one thing the wizard cannot produce, which is the whole reason they are seeded.
  { night: 7, days: -23 },
  { night: 17, days: -6 },
  { night: 7, days: -2, cancelled: true },
  { night: 17, days: 0, ref: 'tonight' },

  // --- the public board, weighted late ---------------------------------------------------------
  // August
  { night: 0, days: 2, ref: 'sold-out' },
  { night: 1, days: 5, ref: 'blues' },
  { night: 2, days: 8 },
  // September
  { night: 3, days: 10 },
  { night: 4, days: 14 },
  { night: 5, days: 18 },
  { night: 6, days: 22 },
  { night: 7, days: 26 },
  { night: 8, days: 30 },
  { night: 9, days: 34, ref: 'duo' },
  // October
  { night: 10, days: 40 },
  { night: 11, days: 44 },
  { night: 12, days: 48 },
  { night: 13, days: 52 },
  { night: 14, days: 56 },
  { night: 15, days: 60 },
  { night: 16, days: 64 },
  { night: 17, days: 68 },
  // November
  { night: 18, days: 71 },
  { night: 19, days: 74, ref: 'keys' },
  { night: 0, days: 77 },
  { night: 1, days: 80 },
  { night: 2, days: 83 },
  { night: 3, days: 86 },
  { night: 4, days: 89 },
  { night: 5, days: 92 },
  { night: 6, days: 95 },
  { night: 7, days: 98 },
  // December
  { night: 8, days: 101 },
  { night: 9, days: 103 },
  { night: 10, days: 106 },
  { night: 11, days: 108 },
  { night: 12, days: 111 },
  { night: 13, days: 113 },
  { night: 14, days: 116 },
  { night: 15, days: 118 },
  { night: 16, days: 121 },
  { night: 17, days: 123 },
  { night: 19, days: 126 },
  { night: 18, days: 129 },
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

// The sessions the bookings below attach to, by `ref` rather than by title or position.
const byRef = new Map<string, SeededSession>();

/* Sorted by the date each entry actually lands on, not by the order they are written above.
   `onWeekday` moves a night forward by up to six days, which is enough to swap two entries written
   three days apart — and the cycle in `schedule` only keeps a repeated night off one page of the
   browse while the sequence is in date order. Sorting here restores that, and it costs nothing:
   these are all created in one pass anyway. */
const scheduleInDateOrder = [...schedule].sort(
  (a, b) => dayOffset(a, must(nights[a.night], 'bad night')) - dayOffset(b, must(nights[b.night], 'bad night')),
);

for (const entry of scheduleInDateOrder) {
  const night = must(nights[entry.night], `unknown night ${entry.night}`);
  const room = must(rooms[night.room], `unknown room ${night.room}`);
  const venue = must(venues[night.venue], `unknown venue ${night.venue}`);

  const candidate = {
    title: night.title,
    summary: night.summary,
    image: night.image,
    // One block, because one block is all the venue's own editor produces — `jamListing.ts` on the
    // client joins them back together with blank lines. The markdown inside it is what becomes
    // paragraphs and bullet lists on the page.
    overview: [{ type: 'text' as const, content: night.overview }],
    date: inDays(dayOffset(entry, night)),
    startTime: night.startTime,
    endTime: night.endTime,
    venueName: room.venueName,
    address: room.address,
    slotDurationMinutes: night.slotDurationMinutes,
    instrumentTemplate: night.instrumentTemplate,
    genres: night.genres,
    skillLevel: night.skillLevel,
  };

  // Through the same schema a real request goes through. Seed data that the API would have rejected
  // is worse than no seed data: it produces a client built against shapes the server cannot
  // actually return, and the mistake surfaces days later.
  //
  // With one exception, and only one: JS05 refuses a date in the past, and refuses a start time that
  // has already gone by today. Both are rules about what a venue may *create*, not about what may
  // exist — every session becomes a past session eventually, just by time passing. Nights already
  // run, and a night running right now, are states the venue's own board has to render, and without
  // this there is no way to produce either in fresh data: the wizard can't create them and neither
  // can the seed. Worse, a `days: 0` fixture would seed fine in the morning and start failing at
  // 20:00, which is a script that breaks by the clock.
  //
  // So a fixture dated today or earlier is validated against tomorrow, which still runs every other
  // rule — the time window, the slot arithmetic, the spot ceiling, the instrument list — and stored
  // with its real date. Nothing else here is allowed past the schema.
  const validated = jamSessionInputSchema.safeParse(
    entry.days <= 0 ? { ...candidate, date: inDays(1) } : candidate,
  );

  if (!validated.success) {
    throw new Error(`seed session "${night.title}" is invalid:\n${z.prettifyError(validated.error)}`);
  }

  const created = await JamSession.create({
    ...validated.data,
    venueId: venue._id,
    // `candidate`, not `validated.data` — the backdated ones were validated against today, and
    // this is where their real date goes back in
    date: dateStringToUtcMidnight(candidate.date),
    // the same generator the controller uses, so seeded slots and real slots cannot differ
    slots: generateSlots(validated.data),
    ...(entry.cancelled ? { status: 'cancelled' } : {}),
  });

  sessions.push(created);

  if (entry.ref) byRef.set(entry.ref, created);
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

/* By `ref`, set on the schedule entry, rather than by position or by title.
 *
 * Position came first and was the worst of the three: inserting a fixture anywhere above these
 * silently re-pointed every booking below at the wrong night, and the failure landed here as "no
 * spots matched ['Keyboard','First Voice']", which says nothing about the actual cause.
 *
 * Title fixed that until the nights became recurring. Now two sessions are called "Blue Monday
 * Blues Jam" and a title lookup quietly returns whichever was created first — the same bug wearing
 * a better name.
 *
 * A `ref` is unique by construction, and it says what these bookings are actually about: not "the
 * night called X" but "the night they belong to". */
const sessionByRef = (ref: string): SeededSession =>
  must(byRef.get(ref), `no seeded session with ref "${ref}"`);

const soldOut = sessionByRef('sold-out');
const blues = sessionByRef('blues');
const duo = sessionByRef('duo');
const keys = sessionByRef('keys');
const tonight = sessionByRef('tonight');

// A slot with nothing left, so the client has a sold-out state to build. Split across four
// musicians, because one person holding all eight spots is not a thing that happens.
await book({ session: soldOut, slotIndex: 0, musician: jane, labels: ['Keyboard', 'First Voice'] });
await book({
  session: soldOut,
  slotIndex: 0,
  musician: must(musicians[1], 'no musician 1'),
  labels: ['First Guitar', 'Second Guitar', 'Third Guitar'],
});
await book({
  session: soldOut,
  slotIndex: 0,
  musician: must(musicians[2], 'no musician 2'),
  labels: ['Drums', 'Second Voice'],
});
await book({
  session: soldOut,
  slotIndex: 0,
  musician: must(musicians[3], 'no musician 3'),
  labels: ['Bass'],
});

// A band: several spots, one submission, one groupId and one QR code — the multi-spot card.
await book({
  session: soldOut,
  slotIndex: 1,
  musician: jane,
  labels: ['First Guitar', 'Bass', 'Drums'],
  bandName: 'The Nightowls',
});

// Partly booked, which is the ordinary case and the one the slot picker spends its life rendering.
await book({
  session: soldOut,
  slotIndex: 2,
  musician: must(musicians[4], 'no musician 4'),
  labels: ['First Guitar'],
});
await book({
  session: soldOut,
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

await book({ session: duo, slotIndex: 1, musician: jane, labels: ['First Voice'] });
await book({
  session: duo,
  slotIndex: 1,
  musician: must(musicians[7], 'no musician 7'),
  labels: ['First Guitar', 'Bass'],
  bandName: 'Two Thirds',
});

await book({
  session: keys,
  slotIndex: 0,
  musician: must(musicians[2], 'no musician 2'),
  labels: ['Keyboard'],
});

/* Three musicians across four spots on the night that is still cancellable, because the venue's
   cancel confirmation counts what it is about to take down with it. One of them books two spots
   under a band name, so the count has a group in it — four bookings, since a booking is per spot,
   and the client has no way to tell that they are three people. */
await book({ session: tonight, slotIndex: 0, musician: jane, labels: ['Keyboard'] });
await book({
  session: tonight,
  slotIndex: 0,
  musician: must(musicians[3], 'no musician 3'),
  labels: ['First Guitar', 'Bass'],
  bandName: 'Kellerei Two',
});
await book({
  session: tonight,
  slotIndex: 1,
  musician: must(musicians[5], 'no musician 5'),
  labels: ['Drums'],
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
console.log(`\n  ${schedule.length} sessions across ${nights.length} recurring nights`);
console.log(`  the public board runs from ${inDays(2)} to ${inDays(129)}`);
console.log(`  "${soldOut.title}" on ${inDays(2)}: slot 1 is full, slot 3 is partly booked\n`);

await mongoose.disconnect();
