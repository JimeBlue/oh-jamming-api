import { GoogleGenAI } from '@google/genai';
import { GEMINI_API_KEY } from '#config';

// Built once at import, like the Cloudinary client next door, and for the same reason: the client
// is a key and an http agent, not a session, so one per request would be the same string wrapped
// over and over.
//
// Null rather than a client with no key. The SDK would happily construct one and fail at the first
// call with a 400 that reads like a bug in our request; the controller checks this instead and
// answers 503, which is the truth.
const gemini = GEMINI_API_KEY ? new GoogleGenAI({ apiKey: GEMINI_API_KEY }) : null;

// Lite, not Flash, and this is the whole reason the free tier is usable here. On this project's
// free quota the full Flash models allow 20 requests a day; the Lite models allow 500. Twenty is
// not a demo-day limit so much as a development one — writing a prompt that produces a decent
// overview takes far more than twenty tries.
//
// It costs nothing in output quality for this particular job: notes in, ~150 words of markdown out,
// in a fixed voice, against a fixed schema. No reasoning, no long context, no code. Check
// aistudio.google.com/rate-limit before changing this — Google no longer publishes the free tier's
// numbers in the docs, they are per-project.
export const GEMINI_MODEL = 'gemini-3.5-flash-lite';

export default gemini;
