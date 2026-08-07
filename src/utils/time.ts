// Every wall-clock value in this app is interpreted in one fixed zone. Jam sessions happen in
// physical rooms in one city, so "19:00" means 19:00 there regardless of where the musician
// reading it happens to be sitting.
//
// This is a decision rather than a default. Storing full UTC instants would be more portable, but
// it drags a timezone conversion into every comparison, every form field and every list header —
// and buys nothing until the app has venues in more than one country.
export const APP_TIMEZONE = 'Europe/Berlin';

// the mongoose-side equivalent of zod's `z.iso.time({ precision: -1 })`. Both layers express the
// same rule; zod rejects the request, this rejects the write.
export const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

// "HH:mm" -> minutes since midnight. Every time calculation in the app goes through this rather
// than through Date arithmetic, which is what keeps DST out of the picture entirely: a session
// that runs 19:00–22:00 is three hours of *wall clock*, on every date of the year.
//
// The defaults in the destructuring are there for `noUncheckedIndexedAccess` — callers always
// validate the format first, so they are never actually reached.
export const timeToMinutes = (time: string): number => {
  const [hours = '0', minutes = '0'] = time.split(':');

  return Number(hours) * 60 + Number(minutes);
};

// built once at module load — constructing an Intl formatter is comparatively expensive, and this
// one never varies
const appTimeFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: APP_TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  // without this, midnight formats as "24:00" in some locales
  hourCycle: 'h23',
});

// The current wall clock in APP_TIMEZONE, as the same two string shapes the API accepts:
// { date: "2026-09-16", time: "19:00" }.
//
// Returning strings rather than a Date is deliberate — an ISO date and an "HH:mm" time both sort
// correctly as strings, so "is this session in the past?" is a plain `<` comparison with no
// conversion and nothing to get subtly wrong.
export const nowInAppTimezone = (): { date: string; time: string } => {
  const parts = Object.fromEntries(
    appTimeFormatter.formatToParts(new Date()).map(({ type, value }) => [type, value]),
  );

  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}`,
  };
};

// "2026-09-16" -> a Date pinned to midnight UTC.
//
// The stored value marks a *calendar day*, not an instant. Pinning it to UTC rather than to local
// midnight means the date never shifts across a boundary when the server's own timezone changes or
// when DST starts — 2026-09-16 stays 2026-09-16 everywhere.
//
// NOTE: do not use `new Date('2026-02-30')` to check whether a date is real. It does not return an
// Invalid Date; it silently rolls over to March 2nd. Calendar validity is checked by `z.iso.date()`
// before a value ever reaches here.
export const dateStringToUtcMidnight = (date: string): Date => new Date(`${date}T00:00:00.000Z`);
