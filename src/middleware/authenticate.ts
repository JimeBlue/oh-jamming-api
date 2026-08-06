import type { RequestHandler } from 'express';
import { ACCESS_COOKIE } from '#utils/cookies';
import { verifyAccessToken } from '#utils/jwt';

// Proves who the caller is. Put this in front of any route that needs a logged-in user; put
// requireRole after it when the route also needs a particular kind of user.
const authenticate: RequestHandler = (req, res, next) => {
  // the token comes from an httpOnly cookie, not an Authorization header, so javascript on the
  // client can never read it
  const accessToken: unknown = req.cookies?.[ACCESS_COOKIE];

  if (typeof accessToken !== 'string') {
    next(new Error('Not authenticated', { cause: { status: 401 } }));
    return;
  }

  try {
    req.user = verifyAccessToken(accessToken);
    next();
  } catch (error) {
    // expiry is the one failure that isn't really a failure: the session may still be valid, the
    // 15-minute access token has just run out. This header is the client's cue to call
    // /auth/refresh and retry rather than dumping the user back on the login page.
    if (error instanceof Error && error.name === 'TokenExpiredError') {
      res.setHeader('WWW-Authenticate', 'token_expired');
      next(new Error('Access token expired', { cause: { status: 401 } }));
      return;
    }

    // a bad signature means the token was forged or tampered with — no hint about which
    next(new Error('Invalid token', { cause: { status: 401 } }));
  }
};

export default authenticate;
