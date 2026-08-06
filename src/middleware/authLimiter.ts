import rateLimit from 'express-rate-limit';
import { isProduction } from '#config';

// Guards the two endpoints where an attacker gets unlimited free guesses: logging in and
// registering. Login answers wrong-password and unknown-email with the same generic 401, so
// there is nothing else slowing a brute-force attempt down.
//
// Counts by IP, which only works behind Render's proxy because app.ts sets `trust proxy` —
// without that every request would look like it came from the proxy and all users would share
// one bucket.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  // loose locally so a Postman session doesn't lock itself out after ten tries
  limit: isProduction ? 10 : 100,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  // treat a whole IPv6 /56 as one client — a single subscriber is typically handed that much
  // address space and could otherwise just rotate through it
  ipv6Subnet: 56,
  // only failed attempts count. A guesser fails by definition, so brute-force protection is
  // unchanged, but someone logging in and out for real never eats into the quota.
  skipSuccessfulRequests: true,
  // matches the { message } shape everything else in the API returns
  message: { message: 'Too many attempts. Try again later.' },
});

export default authLimiter;
