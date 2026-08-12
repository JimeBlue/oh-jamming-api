import { z } from 'zod';
import {
  MAX_OVERVIEW_BLOCK_CHARS,
  MAX_SUMMARY_CHARS,
  MIN_SUMMARY_CHARS,
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
