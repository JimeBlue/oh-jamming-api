import type { RequestHandler } from 'express';
import type { z } from 'zod';
import User from '#models/User';
import type { IdParams } from '#schemas/idParamSchema';
import { type UpdateUserInput, type userInputSchema, userOutputSchema } from '#schemas/userSchema';


type UserInputDTO = z.input<typeof userInputSchema>;

type UserOutputDTO = z.infer<typeof userOutputSchema>;



export const getUsers: RequestHandler<unknown, UserOutputDTO[]> = async (req, res) => {
  const users = await User.find();
  res.json(users.map((user) => userOutputSchema.parse(user)));
};

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
  res.status(201).json(userOutputSchema.parse(user));
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
  const user = await User.findByIdAndDelete(id);

  if (!user) throw new Error('User not found', { cause: { status: 404 } });

  res.json({ message: 'User deleted' });
};
