import rateLimit from 'express-rate-limit';
import { isProduction } from '#config';

// Unlike `authLimiter`, this one sits behind `authenticate` — there are no free guesses to make
// here, and an anonymous request never gets this far. What it protects is the Cloudinary account,
// whose monthly quota is shared by every venue on the platform. The realistic way that quota
// disappears is not an attacker but a client stuck retrying a failed upload in a loop.
const uploadLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  // A venue posting a night uploads one photo. Thirty an hour leaves room for re-picking a few
  // times and for two people at the same venue working at once, while still being nowhere near
  // enough to matter to the quota.
  limit: isProduction ? 30 : 200,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  ipv6Subnet: 56,
  message: { message: 'Too many uploads. Try again in a little while.' },
});

export default uploadLimiter;
