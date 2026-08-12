import { Router } from 'express';
import { generateOverview, generateSummary } from '#controllers/ai';
import aiLimiter from '#middleware/aiLimiter';
import authenticate from '#middleware/authenticate';
import requireRole from '#middleware/requireRole';
import validateBody from '#middleware/validateBody';
import { notesPromptSchema } from '#schemas/aiSchema';

const aiRoutes = Router();

// Its own route rather than a flag on `POST /jam-sessions`, because it is a different operation:
// nothing is created, nothing is stored, and the venue calls it several times before they like the
// answer. What comes back is a string they can edit, delete or ignore — the session is still made
// by the same single POST at the end of the wizard.
//
// The order is the upload route's, and for the same reason: both guards run before anything reaches
// the model, so an anonymous or musician request costs nothing from a quota shared by every venue
// on the platform. `aiLimiter` sits first so a client stuck in a retry loop is refused before its
// token is even read.
// Two routes rather than one with a `kind` in the body, because they are two different things to
// write and the client asks for one or the other — never "whichever". A discriminator would put a
// branch in the request where the URL already says it, and would make the rate limiter unable to
// tell them apart if that ever mattered.
//
// They share `aiLimiter`, which is the honest arrangement: the quota they are spending is one
// quota, so a venue who generates ten summaries has ten fewer overviews to spend.
aiRoutes.post(
  '/overview',
  aiLimiter,
  authenticate,
  requireRole('venue'),
  validateBody(notesPromptSchema),
  generateOverview,
);

aiRoutes.post(
  '/summary',
  aiLimiter,
  authenticate,
  requireRole('venue'),
  validateBody(notesPromptSchema),
  generateSummary,
);

export default aiRoutes;
