import rateLimit from 'express-rate-limit';
import { isProduction } from '#config';

// What this protects is a quota that is not per-user: the Gemini free tier gives the whole deployed
// app 500 generations a day and 15 a minute, shared by every venue on the platform at once. One
// person exploring the button is enough to spend a meaningful slice of that, and a client stuck
// retrying is enough to spend all of it.
//
// Per-IP is an imperfect fit for a shared budget — it can't stop a hundred different people — but
// it stops the case that actually happens, and the alternative is no ceiling at all.
const aiLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  // A venue writing one session generates a few times: read it, adjust the notes, generate again.
  // Twenty an hour is well past that and still leaves the daily 500 able to serve twenty-five
  // people having that same session on the same afternoon.
  limit: isProduction ? 20 : 200,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  ipv6Subnet: 56,
  message: { message: 'Too many generations. Try again in a little while.' },
});

export default aiLimiter;
