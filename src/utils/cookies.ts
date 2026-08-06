import type { CookieOptions, Response } from 'express';
import { REFRESH_TOKEN_TTL, isProduction } from '#config';
import { ACCESS_TOKEN_TTL } from '#utils/jwt';

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

// maxAge is in milliseconds; both TTLs are in seconds
export const accessCookieOptions: CookieOptions = {
  ...baseCookieOptions,
  maxAge: ACCESS_TOKEN_TTL * 1000,
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
