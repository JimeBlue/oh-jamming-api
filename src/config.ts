import { z } from 'zod';

// Every environment variable the app needs, validated once at import time. app.ts imports this
// before anything else, so a missing or malformed value stops the process at boot instead of
// surfacing as an undefined at the first login attempt.
const envSchema = z.object({
  // npm run dev doesn't set this, so it defaults rather than being required — only `npm start`
  // and Render set it to production
  NODE_ENV: z.enum(['development', 'production']).default('development'),
  PORT: z.coerce.number().default(8080),
  MONGODB_URI: z.url({ protocol: /^mongodb/ }),
  // Comma-separated, because the client is deployed in more than one place at once — a Render
  // instance and a Vercel one, during a move — and an origin the list doesn't name cannot log in:
  // the browser blocks the call before the session cookie is ever sent. A single URL still parses,
  // so an existing deploy needs no change.
  CLIENT_URL: z
    .string()
    .optional()
    .transform((value) =>
      (value ?? '')
        .split(',')
        .map((origin) => origin.trim())
        .filter(Boolean)
    )
    .pipe(z.array(z.url())),

  // The project prefix of the Vercel deployment, e.g. `oh-jamming-client`. Every preview gets its
  // own hostname — `<prefix>-git-<branch>-<account>.vercel.app` — so previews cannot be listed in
  // CLIENT_URL ahead of time, and without this a PR preview loads but can't log in.
  //
  // A prefix rather than a bare `*.vercel.app`: this API sends credentials, so anything the origin
  // check lets through can read a logged-in user's data from any page on that host. `*.vercel.app`
  // is every app anybody has ever deployed to Vercel.
  VERCEL_PREVIEW_PREFIX: z.string().min(1).optional(),
  // openssl rand -hex 64 produces 128 chars
  JWT_SECRET: z.string().min(64, 'JWT_SECRET must be at least 64 chars'),
  // seconds, not milliseconds — 30 days
  REFRESH_TOKEN_TTL: z.coerce.number().default(30 * 24 * 60 * 60),

  // Optional, unlike everything above it, and the exception is deliberate. The API is entirely
  // usable without an image host: browsing, booking and posting a session all work, and only
  // `POST /uploads/image` has nothing to talk to. Making these required would mean a deploy that
  // forgot one of them refuses to boot — the whole app down for a feature nobody was using yet.
  // `cloudinaryConfig` below turns their absence into a 503 on that one route instead.
  CLOUDINARY_CLOUD_NAME: z.string().min(1).optional(),
  CLOUDINARY_API_KEY: z.string().min(1).optional(),
  CLOUDINARY_API_SECRET: z.string().min(1).optional(),

  // Optional for the same reason as the three above: without it a venue writes their own overview,
  // which is the path that has always worked, and only `POST /ai/overview` has nothing to talk to.
  GEMINI_API_KEY: z.string().min(1).optional(),
});

const parsedEnv = envSchema.safeParse(process.env);

if (!parsedEnv.success) {
  console.error('Invalid environment variables:\n', z.prettifyError(parsedEnv.error));
  process.exit(1);
}

export const {
  NODE_ENV,
  PORT,
  MONGODB_URI,
  CLIENT_URL,
  VERCEL_PREVIEW_PREFIX,
  JWT_SECRET,
  REFRESH_TOKEN_TTL,
  CLOUDINARY_CLOUD_NAME,
  CLOUDINARY_API_KEY,
  CLOUDINARY_API_SECRET,
  GEMINI_API_KEY,
} = parsedEnv.data;

// drives the cookie flags: sameSite 'none' + secure only work over HTTPS, which localhost isn't
export const isProduction = NODE_ENV === 'production';

// The named origins: whatever CLIENT_URL lists, plus local dev. Vercel previews are matched by
// pattern instead — see `isPreviewOrigin`.
export const allowedOrigins = [...CLIENT_URL, 'http://localhost:3000'];

// Anchored at both ends, and the prefix is escaped: a project called `oh-jamming.client` must not
// turn into a wildcard that matches `oh-jammingXclient-evil.vercel.app`. The suffix Vercel appends
// is a branch or a build hash plus the account name, all lowercase, dash-separated.
const previewOriginPattern = VERCEL_PREVIEW_PREFIX
  ? new RegExp(
      `^https://${VERCEL_PREVIEW_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-[a-z0-9-]+\\.vercel\\.app$`
    )
  : null;

export const isPreviewOrigin = (origin: string): boolean =>
  previewOriginPattern !== null && previewOriginPattern.test(origin);

// All three or none — two out of three is a typo, not a configuration. Narrowed as a whole so
// callers get three strings rather than three `string | undefined`s to re-check individually.
export const cloudinaryConfig =
  CLOUDINARY_CLOUD_NAME && CLOUDINARY_API_KEY && CLOUDINARY_API_SECRET
    ? {
        cloud_name: CLOUDINARY_CLOUD_NAME,
        api_key: CLOUDINARY_API_KEY,
        api_secret: CLOUDINARY_API_SECRET,
      }
    : null;
