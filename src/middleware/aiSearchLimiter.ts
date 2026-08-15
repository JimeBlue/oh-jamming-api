import rateLimit from 'express-rate-limit';
import { isProduction } from '#config';

// Its own limiter rather than `aiLimiter`, because the two routes are not the same kind of thing.
// The writers behind `aiLimiter` are venue-only and sit behind `authenticate` — an anonymous request
// never reaches the model at all, and the population that can spend that quota is the handful of
// people who have posted a session. This one is public and unauthenticated by design: a musician has
// to be able to search before deciding to sign up, so every visitor to the browse can spend from the
// same shared 500-a-day budget.
//
// That is a wider door, and the ceiling behind it has to be lower per client rather than higher.
// Sharing `aiLimiter`'s counter would also be actively wrong in the other direction: a venue writing
// a listing would find its generate button refused because it had been searching the browse.
const aiSearchLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  // Someone genuinely looking for a night rephrases a few times — "jazz jam", then "jazz jam this
  // weekend", then "beginner jazz". Thirty is well past that and still keeps one client from taking
  // a visible slice of a budget the whole platform draws on. Repeats cost nothing anyway: the cache
  // in utils/aiSearchCache answers an identical phrase without a generation, though this counter
  // does not know that and counts the request regardless.
  limit: isProduction ? 30 : 300,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  ipv6Subnet: 56,
  message: { message: 'Too many searches. Try again in a little while, or use the filters.' },
});

export default aiSearchLimiter;
