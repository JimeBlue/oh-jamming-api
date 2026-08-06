import { z } from 'zod';
import { emailField } from '#schemas/userSchema';

// There is no register schema here on purpose: POST /users *is* register, and it already validates
// with userInputSchema.
export const loginSchema = z.strictObject({
  email: emailField,
  // no min(8) here, unlike the input schema. Login isn't the place to enforce a password policy —
  // rejecting a short password with "min length is 8 chars" tells whoever is guessing what the
  // rules are, and it would lock out any account created before the rule changed. Whether the
  // password is right is decided by bcrypt.compare, and the answer is always the same 401.
  password: z.string().min(1, 'password is required'),
});

export type LoginInput = z.infer<typeof loginSchema>;
