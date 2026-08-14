import { Router } from 'express';
import {
  cancelBooking,
  cancelBookingGroup,
  createBooking,
  getBookings,
  getBookingById,
} from '#controllers/bookings';
import authenticate from '#middleware/authenticate';
import requireRole from '#middleware/requireRole';
import validateBody from '#middleware/validateBody';
import validateParams from '#middleware/validateParams';
import validateQuery from '#middleware/validateQuery';
import { bookingInputSchema, bookingQuerySchema, groupIdParamSchema } from '#schemas/bookingSchema';
import { idParamSchema } from '#schemas/idParamSchema';

const bookingRoutes = Router();

// BK17 — nothing here is public, which is what makes this router different from the other two.
// Jam sessions are the product and are browsable by anyone; a booking says who is playing what and
// when, and carries their email besides (BK18), and the only people with a claim to that are the
// musician who made it and the venue running the night. So `authenticate` is mounted once for the
// whole router rather than repeated per verb — there is no route it could be left off by accident.
bookingRoutes.use(authenticate);

bookingRoutes
  .route('/')
  // Deliberately open to both roles. The controller reads `req.user.role` and answers the same
  // question from either end — "what am I playing?" for a musician, "who is playing at my nights?"
  // for a venue — so a `requireRole` here would only mean picking one of them to lock out.
  //
  // `?jamSessionId=` narrows either shape of the question to one night. It does not widen it: the
  // role scope is applied on top, so a venue cannot read another venue's roster by naming its
  // session id — which is public, since the browse is.
  .get(validateQuery(bookingQuerySchema), getBookings)
  .post(requireRole('musician'), validateBody(bookingInputSchema), createBooking);

// Declared before `/:id`. Express would not confuse the two in any case — `/:id` matches a single
// segment and this one has two — but ordering specific paths before parameterised ones is the habit
// that keeps that true when a route is added later.
bookingRoutes
  .route('/group/:groupId')
  .all(validateParams(groupIdParamSchema))
  .delete(requireRole('musician'), cancelBookingGroup);

bookingRoutes
  .route('/:id')
  .all(validateParams(idParamSchema))
  .get(getBookingById)
  // DELETE, but it cancels rather than deletes (BK11), for the same reason jam sessions do: the
  // verb describes what the client is asking for — take my spot off the board — while the server
  // keeps the row, because it is the musician's history and the venue's record of who dropped out.
  //
  // `requireRole('musician')` rather than an ownership check: BK12 says a venue cannot remove one
  // musician from a night it is still running, so it has no business on this route at all. Which
  // *musician* is checked in the controller, where the document is.
  .delete(requireRole('musician'), cancelBooking);

export default bookingRoutes;
