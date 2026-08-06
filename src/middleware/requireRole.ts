import type { RequestHandler } from 'express';
import type { AuthPayload } from '#types/express';

// The role check has to happen here, on the server, on every protected route. Hiding a button in
// the client stops nothing — anyone can call the endpoint directly.
//
// Runs after `authenticate`, which is what puts req.user there. On its own it would treat an
// anonymous request as a 403 rather than a 401, so the pair belongs together:
//   .post(authenticate, requireRole('venue'), createJamSession)
const requireRole =
  (role: AuthPayload['role']): RequestHandler =>
  (req, res, next) => {
    if (req.user?.role !== role) {
      next(new Error(`Only ${role}s can perform this action`, { cause: { status: 403 } }));
      return;
    }

    next();
  };

export default requireRole;
