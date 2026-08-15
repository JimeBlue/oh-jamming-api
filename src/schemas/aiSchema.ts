import { z } from 'zod';
import {
  ALL_GENRES,
  ALL_LEVELS,
  MAX_OVERVIEW_BLOCK_CHARS,
  MAX_SUMMARY_CHARS,
  MIN_SUMMARY_CHARS,
  genres,
  skillLevels,
} from '#schemas/jamSessionSchema';

// A short paragraph or a handful of bullets. The cap is generous next to what the step is for —
// nobody types a thousand characters of notes to get four hundred back — but it is not decoration:
// every character here is billed against a rate limit shared by the whole deployed app, and an
// unbounded field is an invitation to paste a novel into it.
export const MAX_NOTES_CHARS = 1000;

// strictObject, like every other input schema here: an unknown key is a 400 rather than something
// quietly ignored, so a client sending `bulletPoints` instead of `notes` finds out immediately.
//
// One schema for both writers. They differ entirely in what they produce and not at all in what
// they are given — a venue's rough notes — so two identical schemas would only be two places to
// change the cap.
export const notesPromptSchema = z.strictObject({
  notes: z
    .string()
    .trim()
    .min(1, 'notes cannot be empty')
    .max(MAX_NOTES_CHARS, `max length is ${MAX_NOTES_CHARS} chars`),
});

// What the model is asked for, and separately what we check actually came back.
//
// The `responseSchema` handed to Gemini constrains generation; this validates the JSON that
// arrives. They describe the same shape on purpose and are still two different things — one is a
// request, the other is a guarantee, and a model that ignores its schema is exactly the case worth
// catching. The length bound is the one that matters: anything longer than a jam session's overview
// block would be generated, shown, and then rejected by `POST /jam-sessions` at the very end of the
// wizard, which is the worst possible moment to find out.
export const generatedOverviewSchema = z.object({
  overview: z.string().trim().min(1).max(MAX_OVERVIEW_BLOCK_CHARS),
});

/* Both bounds are the jam session's own. The maximum for the same reason as above, and the minimum
   because it is reachable in a way the overview's isn't: the summary is one or two sentences, the
   notes behind it can be three words, and "Open jazz jam." is nine characters — a perfectly sensible
   answer that `POST /jam-sessions` refuses. Caught here, the venue is told to write it themselves;
   caught at the end of the wizard, they are told nothing they can act on. */
export const generatedSummarySchema = z.object({
  summary: z.string().trim().min(MIN_SUMMARY_CHARS).max(MAX_SUMMARY_CHARS),
});

export type NotesPrompt = z.infer<typeof notesPromptSchema>;

// ---------------------------------------------------------------------------------------------
// AI search
// ---------------------------------------------------------------------------------------------

// One sentence typed into a search box. Short on purpose, and much shorter than the notes cap above:
// this is "jazz jam in Berlin this weekend", and anything approaching a paragraph is either a
// mistake or somebody using the search box as a free Gemini terminal on a quota the whole app shares.
export const MAX_SEARCH_CHARS = 200;

export const searchPromptSchema = z.strictObject({
  query: z
    .string()
    .trim()
    .min(1, 'query cannot be empty')
    .max(MAX_SEARCH_CHARS, `max length is ${MAX_SEARCH_CHARS} chars`),
});

// The catch-alls are removed from what the model may answer, and their absence is the point rather
// than tidiness. `?genre=all-genres` means `$in: ['all-genres', 'all-genres']` in the browse — a
// filter that hides every session with a real genre on it, which is the exact opposite of what a
// musician typing "any kind of music" is asking for. "Any" is expressed by omitting the filter, and
// the model has to be unable to say it another way.
export const SEARCHABLE_GENRES = genres.filter(
  (genre): genre is Exclude<(typeof genres)[number], typeof ALL_GENRES> => genre !== ALL_GENRES,
);

export const SEARCHABLE_SKILL_LEVELS = skillLevels.filter(
  (level): level is Exclude<(typeof skillLevels)[number], typeof ALL_LEVELS> => level !== ALL_LEVELS,
);

/* What the model is allowed to have produced.
 *
 * The `responseSchema` handed to Gemini already describes this shape, and this still has to exist
 * for the same reason `generatedOverviewSchema` does: one is a request, the other is a check. The
 * difference here is what a violation should cost. An overview that fails validation is the whole
 * response — there is nothing to hand back but an error. A search that comes back with a genre of
 * "jazz-fusion" is one bad field on an otherwise good reading of the sentence, and throwing the
 * date range away with it would be a worse answer than keeping it.
 *
 * So every filter is `.catch(null)`: an unusable value becomes no value, the rest of the
 * interpretation survives, and the browse runs slightly wider than asked rather than not at all.
 * `understood` and `explanation` have no fallback, because a response missing those isn't a partial
 * reading — it is not a reading at all. */
export const aiSearchResultSchema = z.object({
  // The off-topic gate — the class demo's `return_error` tool, said as a field. Anything that isn't
  // someone looking for a jam night ("what's the weather", "ignore your instructions") lands here as
  // false, and the client shows the message instead of a silently unfiltered list of every session
  // on the platform, which is what "no filters" would otherwise look like.
  understood: z.boolean(),

  genre: z.enum(SEARCHABLE_GENRES).nullish().catch(null),
  skillLevel: z.enum(SEARCHABLE_SKILL_LEVELS).nullish().catch(null),
  city: z.string().trim().min(2).max(60).nullish().catch(null),

  // Inclusive, and both or neither in practice — a single day is the same date twice. Only checked
  // for shape here; that `from` precedes `to` is `jamSessionQuerySchema`'s rule and is left to it.
  from: z.iso.date().nullish().catch(null),
  to: z.iso.date().nullish().catch(null),

  // Shown to the musician as "showing: jazz nights this weekend", so the reading is visible and
  // correctable rather than something they have to infer from the results.
  explanation: z.string().trim().min(1).max(200),

  // The parts of the sentence no filter can express — an instrument, a price, "with spots left".
  // Without this the search quietly answers a different question than the one asked, and looks
  // broken in the one way that is impossible to debug from the outside.
  ignored: z.array(z.string().trim().min(1).max(60)).max(5).catch([]),
});

export type SearchPrompt = z.infer<typeof searchPromptSchema>;
