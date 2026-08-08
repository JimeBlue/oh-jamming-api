import type { RequestHandler } from 'express';
import type { z } from 'zod';
import JamSession from '#models/JamSession';
import RefreshToken from '#models/RefreshToken';
import User from '#models/User';
import type { IdParams } from '#schemas/idParamSchema';
import { type UpdateUserInput, type userInputSchema, userOutputSchema } from '#schemas/userSchema';
import { clearAuthCookies } from '#utils/cookies';
import { issueSession } from '#utils/session';
import { dateStringToUtcMidnight, nowInAppTimezone } from '#utils/time';


type UserInputDTO = z.input<typeof userInputSchema>;

type UserOutputDTO = z.infer<typeof userOutputSchema>;



// There is deliberately no `getUsers`. Listing every account is not something any part of this app
// needs: a venue learns who is playing at its night from `GET /bookings`, which gives it a
// musician's name and nothing else (BK18), and the venue's own public identity lives on the jam
// session rather than on its user record. An index route would only have existed to hand any logged
// in caller every email address on the platform, which is exactly the thing BK18 is careful about.
//
// If a users index is ever genuinely needed, it needs its own narrower output schema — the one
// below includes `email` because it is only ever used on the caller's own account.

// `requireSelf` guards this route, so `id` is always the caller's own. That is what makes it safe to
// return `email`: the projection and the guard are one decision, not two.
export const getUserById: RequestHandler<IdParams, UserOutputDTO> = async (req, res) => {
  const { id } = req.params;
  const user = await User.findById(id);

  if (!user) throw new Error('User not found', { cause: { status: 404 } });

  res.json(userOutputSchema.parse(user));
};

export const createUser: RequestHandler<unknown, UserOutputDTO, UserInputDTO> = async (req, res) => {
  const { email } = req.body;

  // app-layer check for a friendly 409 instead of a raw E11000 from the DB's unique index (the actual guarantee)
  const existingUser = await User.findOne({ email });
  if (existingUser) throw new Error('Email already in use', { cause: { status: 409 } });

  // User.create() runs the pre('save') hook, so the password is hashed on the way in
  const user = await User.create(req.body satisfies UserInputDTO);

  // this endpoint *is* register, so a successful create logs the new user straight in rather than
  // making the client turn around and call /auth/login with the credentials it just sent
  const newUser = userOutputSchema.parse(user);
  await issueSession(res, { userId: newUser.id, role: newUser.role });

  res.status(201).json(newUser);
};


export const updateUser: RequestHandler<IdParams, UserOutputDTO, UpdateUserInput> = async (req, res) => {
  const { id } = req.params;
  const update = req.body;

  if (update.email) {
    // exclude the current user so re-saving their own unchanged email doesn't fire "Email already in use".
    // _id: { $ne: id } means "match documents whose _id is not equal to this id"
    const existingUser = await User.findOne({ email: update.email, _id: { $ne: id } });
    if (existingUser) throw new Error('Email already in use', { cause: { status: 409 } });
  }

  const user = await User.findById(id);

  if (!user) throw new Error('User not found', { cause: { status: 404 } });

  user.set(update);
  await user.save();

  res.json(userOutputSchema.parse(user));
};

export const deleteUser: RequestHandler<IdParams, { message: string }> = async (req, res) => {
  const { id } = req.params;

  // A venue's jam sessions outlive the account that created them: the sessions carry their own
  // venueName and address, so they would keep rendering perfectly while pointing at a venueId that
  // no longer resolves — and any musician holding a spot would have a booking nobody can answer for.
  // Deleting is blocked until the venue has taken those nights off the board itself, which is also
  // what makes the musicians see a cancellation rather than a session that quietly stops existing.
  //
  // Only *upcoming* sessions count. A session is never marked "completed" — its status stays
  // 'active' after the night has happened — so counting every active session would permanently lock
  // a venue out of deleting an account it had ever actually used.
  const upcomingSessions = await JamSession.countDocuments({
    venueId: id,
    status: 'active',
    date: { $gte: dateStringToUtcMidnight(nowInAppTimezone().date) },
  });

  if (upcomingSessions > 0) {
    const sessions = upcomingSessions === 1 ? 'jam session' : 'jam sessions';

    throw new Error(
      `Cancel your ${upcomingSessions} upcoming ${sessions} before deleting your account`,
      { cause: { status: 409 } },
    );
  }

  const user = await User.findByIdAndDelete(id);

  if (!user) throw new Error('User not found', { cause: { status: 404 } });

  // the sessions outlive the account otherwise — refresh would still 401 (it looks the user up),
  // but the rows would sit there until the 30-day TTL swept them
  await RefreshToken.deleteMany({ userId: id });

  // requireSelf guarantees this is the caller's own account, so deleting it logs them out
  clearAuthCookies(res);

  res.json({ message: 'User deleted' });
};
