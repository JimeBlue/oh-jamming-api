import bcrypt from 'bcrypt';
import type { RequestHandler } from 'express';
import type { z } from 'zod';
import RefreshToken from '#models/RefreshToken';
import User from '#models/User';
import type { LoginInput } from '#schemas/authSchema';
import { userOutputSchema } from '#schemas/userSchema';
import { REFRESH_COOKIE, clearAuthCookies } from '#utils/cookies';
import { issueSession } from '#utils/session';
import { hashToken } from '#utils/token';

type UserOutputDTO = z.infer<typeof userOutputSchema>;

// Register lives in the users controller — POST /users is registration.

export const login: RequestHandler<unknown, UserOutputDTO, LoginInput> = async (req, res) => {
  const { email, password } = req.body;

  // the model has `select: false` on password, so it has to be asked for explicitly. This is the
  // only query in the app that does.
  const user = await User.findOne({ email }).select('+password');

  // one message for "no such email" and for "wrong password", deliberately. Two different
  // messages would turn this endpoint into a way to find out which addresses have accounts.
  if (!user?.password || !(await bcrypt.compare(password, user.password))) {
    throw new Error('Incorrect credentials', { cause: { status: 401 } });
  }

  const loggedInUser = userOutputSchema.parse(user);
  await issueSession(res, { userId: loggedInUser.id, role: loggedInUser.role });

  res.json(loggedInUser);
};

// Swaps a valid refresh token for a fresh pair. The client calls this when a request comes back
// 401 with `WWW-Authenticate: token_expired`, so an expired access token is a silent renewal
// rather than a logout.
export const refresh: RequestHandler<unknown, UserOutputDTO> = async (req, res) => {
  const refreshToken: unknown = req.cookies?.[REFRESH_COOKIE];

  if (typeof refreshToken !== 'string') {
    throw new Error('No refresh token provided', { cause: { status: 401 } });
  }

  const storedToken = await RefreshToken.findOne({ tokenHash: hashToken(refreshToken) });

  // either never issued here, or already swept by the TTL index
  if (!storedToken) throw new Error('Invalid refresh token', { cause: { status: 401 } });

  // REUSE DETECTION. This token was already rotated away, so someone is replaying an old one.
  // There is no way to tell the real user from a thief holding a copy, so every session for this
  // user dies and both of them have to log in again.
  if (storedToken.revokedAt) {
    await RefreshToken.deleteMany({ userId: storedToken.userId });
    clearAuthCookies(res);
    throw new Error('Session revoked. Please log in again', { cause: { status: 401 } });
  }

  // checked explicitly rather than trusting the TTL index — mongo's sweep only runs about once a
  // minute, so an expired document can still be sitting there
  if (storedToken.expireAt && storedToken.expireAt.getTime() <= Date.now()) {
    await RefreshToken.deleteOne({ _id: storedToken._id });
    clearAuthCookies(res);
    throw new Error('Refresh token expired', { cause: { status: 401 } });
  }

  const user = await User.findById(storedToken.userId);

  // the account was deleted while the session was still alive
  if (!user) throw new Error('Invalid session', { cause: { status: 401 } });

  // ROTATION. Marked revoked instead of deleted: keeping the row is what makes the reuse check
  // above possible, since a deleted row is indistinguishable from a token that never existed.
  storedToken.revokedAt = new Date();
  await storedToken.save();

  const refreshedUser = userOutputSchema.parse(user);
  await issueSession(res, { userId: refreshedUser.id, role: refreshedUser.role });

  res.json(refreshedUser);
};

// Deliberately succeeds even with no cookie or an unknown one — logging out twice, or with an
// already-expired session, should not be an error the client has to handle.
export const logout: RequestHandler<unknown, { message: string }> = async (req, res) => {
  const refreshToken: unknown = req.cookies?.[REFRESH_COOKIE];

  // hard delete, unlike rotation: the user ended this session on purpose, so there is no replay
  // to detect afterwards
  if (typeof refreshToken === 'string') {
    await RefreshToken.deleteOne({ tokenHash: hashToken(refreshToken) });
  }

  clearAuthCookies(res);

  res.json({ message: 'Logged out' });
};

// Who am I? The client calls this on load to find out whether the cookie it is holding is still
// good, and to get the role that decides what the UI shows.
export const me: RequestHandler<unknown, UserOutputDTO> = async (req, res) => {
  // authenticate has already verified the token and populated req.user
  const userId = req.user?.userId;
  if (!userId) throw new Error('Not authenticated', { cause: { status: 401 } });

  // read fresh from the database rather than trusting the token's contents — a role changed after
  // the token was signed would otherwise stay stale for the life of the token
  const user = await User.findById(userId);
  if (!user) throw new Error('User not found', { cause: { status: 404 } });

  res.json(userOutputSchema.parse(user));
};
