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
});

const parsedEnv = envSchema.safeParse(process.env);

if (!parsedEnv.success) {
  console.error('Invalid environment variables:\n', z.prettifyError(parsedEnv.error));
  process.exit(1);
}

export const { NODE_ENV, PORT, MONGODB_URI, CLIENT_URL, JWT_SECRET, REFRESH_TOKEN_TTL } =
  parsedEnv.data;

// drives the cookie flags: sameSite 'none' + secure only work over HTTPS, which localhost isn't
export const isProduction = NODE_ENV === 'production';
