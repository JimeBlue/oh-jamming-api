import type { RequestHandler } from 'express';
import type { ZodType } from 'zod';
import { z } from 'zod';

// validates req.body against a zod schema before it reaches the controller
const validateBody =
  (schema: ZodType): RequestHandler =>
  (req, res, next) => {
    const { data, error, success } = schema.safeParse(req.body);

    if (!success) {
      next(new Error(z.prettifyError(error), { cause: { status: 400 } }));
      return;
    }

    req.body = data;
    next();
  };

export default validateBody;
