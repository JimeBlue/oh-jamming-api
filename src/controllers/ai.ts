import { ApiError, ThinkingLevel, Type } from '@google/genai';
import type { RequestHandler } from 'express';
import type { ZodType } from 'zod';
import {
  generatedOverviewSchema,
  generatedSummarySchema,
  type NotesPrompt,
} from '#schemas/aiSchema';
import {
  MAX_OVERVIEW_BLOCK_CHARS,
  MAX_SUMMARY_CHARS,
  MIN_SUMMARY_CHARS,
} from '#schemas/jamSessionSchema';
import gemini, { GEMINI_MODEL } from '#utils/gemini';

// The whole of the model's brief for the long description. It carries the domain — that this is a
// jam session and who reads it — so the request itself can be nothing but the venue's own notes.
//
// The formatting rules are not stylistic preferences, they are the client's editor written down:
// the overview is edited in TipTap with five buttons (bold, italic, link, and the two lists) and
// every other StarterKit extension switched off. A heading or a blockquote in the generated
// markdown is silently dropped on the way into the editor, so the venue would watch text they just
// generated lose a line on arrival.
//
// The instruction not to invent is the one that earns its place. The date, the time, the address
// and the line-up are all real fields the venue filled in three steps ago, and a model that helpfully
// writes "doors at 8pm" has published a fact nobody entered and nobody can correct from here.
const SYSTEM_INSTRUCTION = `You write the "about this session" text for jam session listings on Oh Jamming, a site where musicians book a slot to play at a jam night.

You are given a venue's rough notes. Turn them into the finished description that musicians read before deciding whether to come and play.

The notes arrive as bullets or as a paragraph, and either way they are raw material and never the finished text. Handing them back with the punctuation tidied is a failure, and it is the failure to watch for when the notes already read like sentences — a fluent paragraph is still a note. Always rewrite: into the voice below, addressed to the musician reading the listing, with any concrete items pulled out into a labelled list.

Voice: warm, concrete and plain. Write for a musician deciding how to spend their evening. No marketing superlatives, no "unforgettable experience", no exclamation marks.

Rewriting changes the form, never the facts. Length therefore follows how much the notes actually *say*, not how long they are or how well they are written: notes naming six things support 120 to 200 words, a single vague line supports two or three sentences. Never more than ${MAX_OVERVIEW_BLOCK_CHARS} characters. Padding a thin note up to a target length can only be done by making things up, so there is no target length — write everything the notes support and then stop.

Format: markdown, using only paragraphs, **bold**, *italic*, links and bullet or numbered lists. Never use headings, blockquotes, code blocks or horizontal rules — they cannot be displayed. A short **bold** line is how you label a list.

Where the notes *already name* concrete items — backline, what to bring, house rules — set those out as a bullet list under a short bold label, and use a second labelled list rather than filing an item under a label it contradicts. At most two lists. A musician scans a listing for exactly those before deciding to come. Everything else is prose. Never put an item under a label it does not belong to.

A list only ever rearranges what the notes say. If the notes name no equipment, there is no equipment list. If they name one thing, the list has one line — never complete a list to a plausible length. An invented amplifier reads exactly like a real one, and the musician who turns up without theirs was told a lie by the listing.

Notes naming nothing concrete get no lists at all. Given only "jazz jam", the entire correct answer is a sentence or two saying there is an open jazz jam and anyone is welcome — no backline, no house band, no sign-up procedure, no start time. Rewriting into the voice above is still required; there is simply less to rewrite.

Line breaks are real newline characters in the JSON string, and the markdown does not render without them. A blank line between paragraphs, a newline after the bold label, and every bullet on its own line beginning with "- ".

Never invent specifics. The date, start and end times, address, venue name, genres, skill levels and instruments are entered separately by the venue and are already shown beside your text. Do not state or imply any of them unless the notes say so, and never invent prices, ticket links, house rules or names.

If the notes are too thin to write from, write a short, honest, general description of a jam night rather than inventing detail to fill the space.

Write in English.`;

// The brief for the short description — the line a musician reads in a list of sessions before
// deciding whether to open one at all.
//
// A different job from the overview rather than a shorter version of it, which is why it is a
// separate instruction and not a length parameter. The overview is what the night *is*, in full,
// with its backline laid out; this is the one thing that would make someone stop scrolling. Given
// the same notes the two should not read like the same text truncated.
//
// Plain text, and that constraint is the client again: the summary is a plain textarea and the
// listing renders it as a bare paragraph, so markdown here would show its own asterisks to every
// musician who saw the session.
const SUMMARY_INSTRUCTION = `You write the one-line pitch for jam session listings on Oh Jamming, a site where musicians book a slot to play at a jam night.

You are given a venue's rough notes. Write the short description that appears under the session's title in a list of sessions — the line that decides whether a musician opens it at all.

The notes arrive as bullets or as a paragraph, and either way they are raw material and never the finished text. Handing them back with the punctuation tidied is a failure, and that is the failure to watch for when the notes already read like sentences.

Voice: warm, concrete and plain. Write for a musician deciding how to spend their evening. No marketing superlatives, no "unforgettable experience", no exclamation marks.

One or two sentences. Between ${MIN_SUMMARY_CHARS} and ${MAX_SUMMARY_CHARS} characters, and aim for roughly 100 to 200 — this is a pitch, not a description.

Plain text only. No markdown, no bold, no bullet points, no line breaks, no headings. Anything you write is displayed exactly as typed.

Pick the one or two things from the notes most likely to make a musician come, and leave the rest out. This text sits directly above the full description, so repeating everything is wasted space; a night whose notes list five pieces of backline is better sold by "full backline provided" than by the inventory.

Never invent specifics. The date, start and end times, address, venue name, genres, skill levels and instruments are entered separately by the venue and are already shown beside your text. Do not state or imply any of them unless the notes say so, and never invent prices, ticket links, house rules or names. If the notes say only "jazz jam", the correct answer is one honest sentence saying there is an open jazz jam and players are welcome.

Write in English.`;

/* One request path, two briefs.
 *
 * Both writers do exactly the same thing to the same input — notes in, one string out, validated
 * against the field it has to fit — and differ only in what they are told to write and what shape
 * counts as valid. Written twice, the two would drift on the parts nobody is thinking about: the
 * error mapping, the 503 check, the fact that thinking is off.
 *
 * `field` is threaded through to the model's response schema rather than being fixed as `text`,
 * because the property name is part of what the model is told it is producing.
 */
const writer = <TField extends string>({
  field,
  fieldDescription,
  systemInstruction,
  schema,
}: {
  field: TField;
  fieldDescription: string;
  systemInstruction: string;
  schema: ZodType<Record<TField, string>>;
}): RequestHandler<unknown, Record<TField, string>, NotesPrompt> => {
  return async (req, res, next) => {
    if (!gemini) {
      // 503, not 500: the server is healthy and the wizard still works — this one button doesn't.
      // Same reasoning as the image upload, see the note in config.ts.
      next(new Error('AI generation is not configured on this server', { cause: { status: 503 } }));
      return;
    }

    const { notes } = req.body;

    try {
      const response = await gemini.models.generateContent({
        model: GEMINI_MODEL,
        contents: notes,
        config: {
          systemInstruction,
          // Structured output rather than free text, for three reasons that all bite in practice:
          // the client needs a known shape and not a model's idea of formatting; free generation
          // opens with "Here's a great description for your event:" often enough that the
          // alternative is regexing preambles off; and a JSON body parses on arrival like every
          // other response here.
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: { [field]: { type: Type.STRING, description: fieldDescription } },
            required: [field],
          },
          // Nothing here needs deliberation — it is a rewrite of text we already have — and
          // thinking tokens are latency the venue waits through and quota spent on a shared budget.
          thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL },
          // Some variation between generations is the point: the venue's second click is them
          // asking for a different take, not the same one again.
          temperature: 0.9,
        },
      });

      // Empty rather than an error is what a safety block looks like from here, and it is also what
      // a truncated response looks like. Either way there is nothing to hand back.
      if (!response.text) {
        next(new Error('The AI returned nothing usable', { cause: { status: 502 } }));
        return;
      }

      // Two ways this fails even though the model was handed a schema: the text can be invalid
      // JSON, and it can be valid JSON that doesn't fit the field it is destined for. Both are
      // caught here rather than at `POST /jam-sessions`, which is several steps and twenty minutes
      // later, and where the venue can no longer tell which of eight screens is at fault.
      const parsed = schema.safeParse(JSON.parse(response.text));

      if (!parsed.success) {
        next(new Error('The AI returned nothing usable', { cause: { status: 502 } }));
        return;
      }

      res.json(parsed.data);
    } catch (error) {
      // The quota is the failure that will actually happen — 500 generations a day and 15 a minute
      // across the whole deployed app — and it is the one the venue can do something about, so it
      // keeps its own status and its own sentence instead of arriving as a generic 500.
      if (error instanceof ApiError && error.status === 429) {
        next(
          new Error(
            'The AI is busy right now. Try again in a few minutes, or write this yourself.',
            { cause: { status: 429 } },
          ),
        );
        return;
      }

      // Anything else — a rejected request, a model that went away, a JSON.parse that threw — is
      // upstream's problem or ours, and neither is something the client can fix by retrying
      // differently. 502 says the failure was behind this API rather than in the request.
      if (error instanceof ApiError || error instanceof SyntaxError) {
        next(new Error('The AI service could not be reached', { cause: { status: 502 } }));
        return;
      }

      next(error);
    }
  };
};

export const generateOverview = writer({
  field: 'overview',
  fieldDescription: 'The finished session description, in markdown',
  systemInstruction: SYSTEM_INSTRUCTION,
  schema: generatedOverviewSchema,
});

export const generateSummary = writer({
  field: 'summary',
  fieldDescription: 'The one-line pitch, in plain text',
  systemInstruction: SUMMARY_INSTRUCTION,
  schema: generatedSummarySchema,
});
