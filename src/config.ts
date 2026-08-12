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
  CLIENT_URL: z.url().optional(),
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
  JWT_SECRET,
  REFRESH_TOKEN_TTL,
  CLOUDINARY_CLOUD_NAME,
  CLOUDINARY_API_KEY,
  CLOUDINARY_API_SECRET,
} = parsedEnv.data;

// drives the cookie flags: sameSite 'none' + secure only work over HTTPS, which localhost isn't
export const isProduction = NODE_ENV === 'production';

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
