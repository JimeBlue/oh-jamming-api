import type { CookieOptions, Response } from 'express';
import { REFRESH_TOKEN_TTL, isProduction } from '#config';

export const ACCESS_COOKIE = 'accessToken';
export const REFRESH_COOKIE = 'refreshToken';

const baseCookieOptions: CookieOptions = {
  // the whole point of cookie auth over a Bearer token in localStorage: javascript can't read
  // this, so an XSS bug can't walk off with the session
  httpOnly: true,

  // in production the client and the API are two separate onrender.com services, and onrender.com
  // is on the Public Suffix List — so the browser treats them as cross-site and silently drops
  // 'lax' and 'strict' cookies. 'none' is the only value that survives, and it requires `secure`,
  // which requires HTTPS. Locally there is no HTTPS and no cross-site problem, so 'lax' is both
  // sufficient and safer (it still blocks CSRF from other origins).
  sameSite: isProduction ? 'none' : 'lax',
  secure: isProduction,

  // stated explicitly because clearCookie has to be given the same path to match, and a default
  // that drifts would leave uncleared cookies behind
  path: '/',
};

/* maxAge is in milliseconds; REFRESH_TOKEN_TTL is in seconds.

   The access cookie deliberately outlives the token inside it, and that is what
   makes the refresh flow work at all. Giving it ACCESS_TOKEN_TTL puts two clocks
   on one job and the browser's wins: at 15 minutes it deletes the cookie, so the
   expired token never arrives, `authenticate` sees no token rather than a stale
   one, and answers a bare 401 with no `WWW-Authenticate: token_expired`. The
   client only refreshes on that header, so it reads the 401 as "logged out" and
   returns a user to /login whose 30-day refresh token was valid the whole time.
   The fifteen minutes was never meant to be visible to anyone.

   Outliving its token costs the cookie nothing, because the cookie was never the
   thing being trusted: `verifyAccessToken` checks the JWT's own `exp` on every
   request, so a stale one carries something already worthless. Its only remaining
   job is to keep arriving, so the *server* gets to say "expired" instead of the
   browser silently saying "gone". */
export const accessCookieOptions: CookieOptions = {
  ...baseCookieOptions,
  maxAge: REFRESH_TOKEN_TTL * 1000,
};

export const refreshCookieOptions: CookieOptions = {
  ...baseCookieOptions,
  maxAge: REFRESH_TOKEN_TTL * 1000,
};

// register, login and refresh all end the same way, with a fresh pair of cookies
export const setAuthCookies = (res: Response, accessToken: string, refreshToken: string): void => {
  res.cookie(ACCESS_COOKIE, accessToken, accessCookieOptions);
  res.cookie(REFRESH_COOKIE, refreshToken, refreshCookieOptions);
};

// a browser only overwrites a cookie when the name, path and domain all match, so clearing has to
// reuse the same options it was set with
export const clearAuthCookies = (res: Response): void => {
  res.clearCookie(ACCESS_COOKIE, accessCookieOptions);
  res.clearCookie(REFRESH_COOKIE, refreshCookieOptions);
};
