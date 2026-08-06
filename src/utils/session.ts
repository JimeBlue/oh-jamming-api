import type { Response } from 'express';
import RefreshToken from '#models/RefreshToken';
import type { AuthPayload } from '#types/express';
import { setAuthCookies } from '#utils/cookies';
import { createAccessToken } from '#utils/jwt';
import { generateRefreshToken, hashToken } from '#utils/token';

// Starts a logged-in session: a short-lived signed access token, a long-lived refresh token whose
// hash is recorded in the database, both handed to the browser as httpOnly cookies.
//
// Shared by the three places that log someone in — registering (POST /users), logging in, and
// rotating an expired session on refresh — so the three can never drift apart.
export const issueSession = async (res: Response, user: AuthPayload): Promise<void> => {
  const accessToken = createAccessToken(user);

  // the raw token only ever exists here and in the cookie; the database gets the hash
  const refreshToken = generateRefreshToken();
  await RefreshToken.create({ tokenHash: hashToken(refreshToken), userId: user.userId });

  setAuthCookies(res, accessToken, refreshToken);
};
