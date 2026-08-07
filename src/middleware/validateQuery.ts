import type { RequestHandler } from 'express';
import type { ZodType } from 'zod';
import { z } from 'zod';

// validates req.query (the ?filters=on&a=url) against a zod schema before it reaches the controller
const validateQuery =
  (schema: ZodType): RequestHandler =>
  (req, res, next) => {
    const { data, error, success } = schema.safeParse(req.query);

    if (!success) {
      next(new Error(z.prettifyError(error), { cause: { status: 400 } }));
      return;
    }

    // Not `req.query = data`, unlike its siblings validateBody and validateParams. Express 5 exposes
    // req.query through a getter with no setter — it parses the query string lazily — so a plain
    // assignment throws "Cannot set property query of #<IncomingMessage> which has only a getter".
    // defineProperty replaces the accessor with a data property instead.
    Object.defineProperty(req, 'query', { value: data, writable: true, configurable: true });
    next();
  };

export default validateQuery;
