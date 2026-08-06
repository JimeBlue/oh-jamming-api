import { Router } from 'express';
import { createUser, deleteUser, getUserById, getUsers, updateUser } from '#controllers/users';
import authLimiter from '#middleware/authLimiter';
import authenticate from '#middleware/authenticate';
import requireSelf from '#middleware/requireSelf';
import validateBody from '#middleware/validateBody';
import validateParams from '#middleware/validateParams';
import { idParamSchema } from '#schemas/idParamSchema';
import { updateUserSchema, userInputSchema } from '#schemas/userSchema';

const userRoutes = Router();

userRoutes
  .route('/')
  .get(authenticate, getUsers)
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
  .get(getUserById)
  // requireSelf before validateBody: no point parsing a body the caller isn't allowed to submit
  .put(requireSelf, validateBody(updateUserSchema), updateUser)
  .delete(requireSelf, deleteUser);

export default userRoutes;
