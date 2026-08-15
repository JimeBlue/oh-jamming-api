import type { z } from 'zod';
import type { aiSearchResultSchema } from '#schemas/aiSchema';

type AiSearchResult = z.infer<typeof aiSearchResultSchema>;

// What gets cached is the *interpretation* — "jazz jam this weekend" -> a set of filters — and never
// the sessions those filters find. Two different lifetimes: what the sentence means is settled the
// moment it is read, while which nights match it changes with every booking made against them. The
// browse that runs afterwards is an indexed Mongo query and is not the slow part of anything.
//
// The reason to cache at all is quota rather than speed. The Gemini free tier gives the whole
// deployed app 500 generations a day, shared, and this endpoint is public, unauthenticated, and on
// the most-visited page in the app. Search phrasings repeat hard across users — a handful of
// sentences account for most of what anyone types into a box like this — so the hit rate is high
// exactly when it matters, which is a lot of people using the site at once.

// A day's worth of distinct search phrasings, which is far more than this app will see, at a few
// hundred bytes each. In-memory and per-process, so a Render restart empties it; that costs one
// Gemini call per phrase and needs no Redis to avoid.
const MAX_ENTRIES = 500;

const cache = new Map<string, AiSearchResult>();

// The date is half the key, and it is the half that is easy to leave out and impossible to notice.
// Every interpretation this cache holds contains resolved dates — "tomorrow" is stored as
// "2026-08-16", not as the word — so an entry made on Saturday answers Sunday's identical question
// with yesterday's weekend. Keying on the day it was read means those entries are never found again
// rather than being found and quietly wrong.
//
// Normalising the query is what makes the cache work at all: "Jazz jam  this weekend" and "jazz jam
// this weekend" are one question, and case and spacing are the two ways people write it differently
// without meaning anything by it.
const keyFor = (query: string, today: string): string =>
  `${today}|${query.toLowerCase().replace(/\s+/g, ' ').trim()}`;

export const readCachedSearch = (query: string, today: string): AiSearchResult | undefined => {
  const key = keyFor(query, today);
  const hit = cache.get(key);

  // Re-inserting on a hit is the whole of the LRU: a Map iterates in insertion order, so deleting
  // and setting moves this entry to the back of the queue and the eviction below always takes the
  // least recently used one. Without it, eviction would drop whatever happened to be searched first
  // this morning no matter how popular it has been since.
  if (hit) {
    cache.delete(key);
    cache.set(key, hit);
  }

  return hit;
};

export const writeCachedSearch = (query: string, today: string, result: AiSearchResult): void => {
  cache.set(keyFor(query, today), result);

  if (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value;

    if (oldest !== undefined) cache.delete(oldest);
  }
};
