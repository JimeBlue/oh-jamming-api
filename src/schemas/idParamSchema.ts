import { isValidObjectId } from 'mongoose';
import { z } from 'zod';

// shared across every resource — validates that :id in the URL is a well-formed Mongo ObjectId.
// Without this, a malformed id (e.g. "not-a-valid-id") reaches User.findById() and Mongoose
// throws a raw CastError instead of a clean validation error.
export const idParamSchema = z.object({
  id: z.string().refine(isValidObjectId, 'must be a valid id'),
});

export type IdParams = z.infer<typeof idParamSchema>;
