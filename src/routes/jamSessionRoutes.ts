import { Router } from 'express';
import {
  cancelJamSession,
  createJamSession,
  getJamSessionById,
  getJamSessions,
  updateJamSession,
} from '#controllers/jamSessions';
import authenticate from '#middleware/authenticate';
import requireRole from '#middleware/requireRole';
import validateBody from '#middleware/validateBody';
import validateParams from '#middleware/validateParams';
import validateQuery from '#middleware/validateQuery';
import { idParamSchema } from '#schemas/idParamSchema';
import {
  jamSessionInputSchema,
  jamSessionQuerySchema,
  updateJamSessionSchema,
} from '#schemas/jamSessionSchema';

const jamSessionRoutes = Router();

// Reading is public, writing is venues only. A visitor has to be able to see what the app offers
// before deciding to register — the sessions are the product.
//
// `requireRole('venue')` always comes after `authenticate`, which is what makes an anonymous request
// a 401 rather than a 403: "who are you?" has to be answered before "are you allowed?".
jamSessionRoutes
  .route('/')
  .get(validateQuery(jamSessionQuerySchema), getJamSessions)
  .post(
    authenticate,
    requireRole('venue'),
    validateBody(jamSessionInputSchema),
    createJamSession,
  );

// validateParams runs for every verb, and here it goes first rather than after authenticate as it
// does on /users/:id. The difference is that GET is public: there is no identity to establish, so
// a malformed id is simply a malformed id.
jamSessionRoutes
  .route('/:id')
  .all(validateParams(idParamSchema))
  .get(getJamSessionById)
  .patch(authenticate, requireRole('venue'), validateBody(updateJamSessionSchema), updateJamSession)
  // DELETE, but it cancels rather than deletes (JS11). The verb describes what the client is asking
  // for — take this session off the board — while the server keeps the row so the bookings hanging
  // off it still resolve. Ownership is checked in the controller, which is where the document is.
  .delete(authenticate, requireRole('venue'), cancelJamSession);

export default jamSessionRoutes;
