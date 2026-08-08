import { Router } from 'express';
import { createUser, deleteUser, getUserById, updateUser } from '#controllers/users';
import authLimiter from '#middleware/authLimiter';
import authenticate from '#middleware/authenticate';
import requireSelf from '#middleware/requireSelf';
import validateBody from '#middleware/validateBody';
import validateParams from '#middleware/validateParams';
import { idParamSchema } from '#schemas/idParamSchema';
import { updateUserSchema, userInputSchema } from '#schemas/userSchema';

const userRoutes = Router();

// No GET. There is no index route, on purpose: nothing in the app needs a list of accounts, and one
// would hand any logged-in caller every email address on the platform. A GET here now falls through
// to notFoundHandler as a 404. See the note above `getUserById` in the controller.
userRoutes
  .route('/')
  // POST /users *is* register, so it stays public — and is rate limited for the same reason
  // /auth/login is
  .post(authLimiter, validateBody(userInputSchema), createUser);

// .all() runs both checks once for every verb on this path. authenticate goes first so an
// anonymous caller gets 401 and learns nothing else — otherwise a malformed id would come back
// as a 400 before we'd established who was asking. validateParams then rejects a bad id before
// any handler touches the database.
userRoutes
  .route('/:id')
  .all(authenticate, validateParams(idParamSchema))
  // requireSelf on the read too, not just the writes. Reading an account exposes its email, and
  // "any logged-in user may look up anyone" is a different rule from "any logged-in user may edit
  // only themselves" — there is no caller that needs the first one. What a venue is allowed to know
  // about a musician it has a booking with comes from GET /bookings instead (BK18).
  .get(requireSelf, getUserById)
  // requireSelf before validateBody: no point parsing a body the caller isn't allowed to submit
  .patch(requireSelf, validateBody(updateUserSchema), updateUser)
  .delete(requireSelf, deleteUser);

export default userRoutes;
