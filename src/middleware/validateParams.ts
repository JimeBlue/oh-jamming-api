import type { RequestHandler } from 'express';
import type { ZodType } from 'zod';
import { z } from 'zod';

// validates req.params (e.g. the :id in the URL) against a zod schema before it reaches the controller
const validateParams =
  (schema: ZodType): RequestHandler =>
  (req, res, next) => {
    const { data, error, success } = schema.safeParse(req.params);

    if (!success) {
      next(new Error(z.prettifyError(error), { cause: { status: 400 } }));
      return;
    }

    req.params = data as typeof req.params;
    next();
  };

export default validateParams;
