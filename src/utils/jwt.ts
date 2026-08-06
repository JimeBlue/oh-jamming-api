import jwt from 'jsonwebtoken';
import { JWT_SECRET } from '#config';
// type-only, so `verbatimModuleSyntax` erases it — node never tries to resolve the .d.ts at runtime
import type { AuthPayload } from '#types/express';

// seconds. Short on purpose: a stolen access token can't be revoked, so the window in which it is
// useful is the only real defence. The refresh token is what keeps the user logged in past this.
export const ACCESS_TOKEN_TTL = 15 * 60;

export const createAccessToken = (payload: AuthPayload): string =>
  // a number here means seconds — the string forms ('15m') go through the `ms` package and are
  // easier to get subtly wrong
  jwt.sign(payload, JWT_SECRET, { expiresIn: ACCESS_TOKEN_TTL });

// throws on a bad signature (JsonWebTokenError) or a stale token (TokenExpiredError). The caller
// decides what those mean — see the authenticate middleware.
export const verifyAccessToken = (token: string): AuthPayload =>
  // safe to assert: we only ever verify tokens this module signed, so the shape is ours
  jwt.verify(token, JWT_SECRET) as AuthPayload;
