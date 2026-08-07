import {
  MAX_SLOTS_PER_SESSION,
  MAX_SPOTS_PER_SESSION,
  type JamSessionInput,
} from '#schemas/jamSessionSchema';
import { minutesToTime, timeToMinutes } from '#utils/time';

// JS03/JS04 — the expansion from what the venue filled in to what a musician can actually book.
//
// A venue describes its night once: "19:00 to 22:00, 60-minute slots, 3 lead guitars and a drum
// kit". That becomes three slots, each holding four individually claimable spots with names a
// musician can recognise. The venue never types "Second Lead Guitar" and never sees a spot id.
//
// Deliberately a pure function — no database, no request, no clock. Everything it needs arrives in
// the argument, which is what makes it exhaustively testable on its own and what keeps the one
// piece of real arithmetic in this app out of a controller.

// what the venue's form produces
type InstrumentTemplate = JamSessionInput['instrumentTemplate'];

// what the generator needs: the time window and the line-up, nothing else
type SlotGenerationInput = Pick<
  JamSessionInput,
  'startTime' | 'endTime' | 'slotDurationMinutes' | 'instrumentTemplate'
>;

// `spotId` and `bookingId` are absent on purpose. The model supplies both — a fresh uuid and a
// null booking — so id generation lives in exactly one place and this function stays pure.
type GeneratedSpot = {
  instrument: string;
  label: string;
};

type GeneratedSlot = {
  startTime: string;
  endTime: string;
  spots: GeneratedSpot[];
};

// Written out rather than computed, because English ordinals are irregular enough that a generator
// is more code than the list. Twenty entries covers MAX_SPOTS_PER_INSTRUMENT exactly; the fallback
// below covers the case where that cap is ever raised without this list being updated.
const ORDINALS = [
  'First',
  'Second',
  'Third',
  'Fourth',
  'Fifth',
  'Sixth',
  'Seventh',
  'Eighth',
  'Ninth',
  'Tenth',
  'Eleventh',
  'Twelfth',
  'Thirteenth',
  'Fourteenth',
  'Fifteenth',
  'Sixteenth',
  'Seventeenth',
  'Eighteenth',
  'Nineteenth',
  'Twentieth',
];

// A lone instrument gets its bare name — "First Drums" is odd when there is no second. Past that,
// ordinals are what let a musician say which spot they took.
const spotLabel = (instrument: string, index: number, spotsTotal: number): string => {
  if (spotsTotal === 1) return instrument;

  const ordinal = ORDINALS[index];

  return ordinal ? `${ordinal} ${instrument}` : `${instrument} ${index + 1}`;
};

// The line-up for a single slot, in the order the venue listed it. Every slot gets an identical
// copy of this, which is what makes "the 20:00 slot still needs a bass player" a question about one
// slot rather than about the session as a whole.
const buildSpotTemplate = (instrumentTemplate: InstrumentTemplate): GeneratedSpot[] =>
  instrumentTemplate.flatMap(({ instrument, spotsTotal }) =>
    Array.from({ length: spotsTotal }, (_, index) => ({
      instrument,
      label: spotLabel(instrument, index, spotsTotal),
    })),
  );

export const generateSlots = ({
  startTime,
  endTime,
  slotDurationMinutes,
  instrumentTemplate,
}: SlotGenerationInput): GeneratedSlot[] => {
  const startMinutes = timeToMinutes(startTime);
  const windowMinutes = timeToMinutes(endTime) - startMinutes;

  // These four guards restate rules the input schema already enforces, so a request that reached a
  // controller can never trip them. They are here for the callers that bypass zod — a seed script,
  // a migration, a future controller written in a hurry — where the alternative to throwing is
  // silently writing a session whose slots don't match its own advertised times.
  //
  // They throw bare Errors on purpose: no `cause.status`, so `errorHandler` reports 500. A request
  // that gets this far means validation was skipped, and that is a bug in the app, not in the
  // request.
  if (windowMinutes <= 0) {
    throw new Error('generateSlots: endTime must be after startTime');
  }

  if (windowMinutes % slotDurationMinutes !== 0) {
    throw new Error(
      `generateSlots: ${windowMinutes} minutes does not divide evenly into ${slotDurationMinutes}-minute slots`,
    );
  }

  const slotCount = windowMinutes / slotDurationMinutes;

  if (slotCount > MAX_SLOTS_PER_SESSION) {
    throw new Error(`generateSlots: ${slotCount} slots exceeds the max of ${MAX_SLOTS_PER_SESSION}`);
  }

  const spotTemplate = buildSpotTemplate(instrumentTemplate);
  const totalSpots = slotCount * spotTemplate.length;

  if (totalSpots > MAX_SPOTS_PER_SESSION) {
    throw new Error(
      `generateSlots: ${totalSpots} spots exceeds the max of ${MAX_SPOTS_PER_SESSION}`,
    );
  }

  return Array.from({ length: slotCount }, (_, index) => {
    const slotStart = startMinutes + index * slotDurationMinutes;

    return {
      startTime: minutesToTime(slotStart),
      endTime: minutesToTime(slotStart + slotDurationMinutes),
      // a fresh object per slot rather than the shared template entry. Mongoose copies these on
      // the way in either way, but sharing references means a later `slots[0].spots[0].label = ...`
      // would rewrite that spot in every slot at once — the kind of bug that only shows up once
      // something starts editing generated data.
      spots: spotTemplate.map((spot) => ({ ...spot })),
    };
  });
};
