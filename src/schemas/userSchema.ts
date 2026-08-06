import { z } from 'zod';

export const userRoles = ['venue', 'musician'] as const;


const userFields = z.strictObject({
  firstName: z.string().min(2, 'min length is 2 chars').max(255, 'max length is 255 chars'),
  lastName: z.string().min(2, 'min length is 2 chars').max(255, 'max length is 255 chars'),
  // trimmed before the email check, not after — zod runs before mongoose, so the model's `trim: true`
  // would never see a value that zod had already rejected for the surrounding whitespace
  email: z
    .string()
    .trim()
    .pipe(z.email('must be a valid email address').min(5, 'min length is 5 chars')),

  password: z.string().min(8, 'min length is 8 chars'),
  role: z.enum(userRoles, 'role must be either venue or musician'),
  instrumentsPlayed: z.array(z.string().min(1, 'instrument cannot be empty')).optional(),
});


const instrumentsMatchRole = (
  user: { role?: (typeof userRoles)[number]; instrumentsPlayed?: string[] },
  ctx: z.RefinementCtx,
) => {
  if (user.role === 'venue' && user.instrumentsPlayed?.length) {
    ctx.addIssue({
      code: 'custom',
      path: ['instrumentsPlayed'],
      message: 'only musicians can have instrumentsPlayed',
    });
  }
};

export const userInputSchema = userFields.superRefine(instrumentsMatchRole);

export type UserInput = z.infer<typeof userInputSchema>;


export const updateUserSchema = userFields
  .partial()
  // an empty body would be a no-op update, so it's rejected rather than silently accepted
  .refine((update) => Object.keys(update).length > 0, 'at least one field is required')
  .superRefine(instrumentsMatchRole);

export type UpdateUserInput = z.infer<typeof updateUserSchema>;


export const userOutputSchema = z.object({
  id: z.string(),
  firstName: userFields.shape.firstName,
  lastName: userFields.shape.lastName,
  email: userFields.shape.email,
  role: userFields.shape.role,
  instrumentsPlayed: z.array(z.string()),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type UserOutput = z.infer<typeof userOutputSchema>;
