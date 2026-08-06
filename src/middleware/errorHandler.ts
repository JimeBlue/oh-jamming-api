import type { ErrorRequestHandler } from 'express';
import { Error as MongooseError } from 'mongoose';

const errorHandler: ErrorRequestHandler = (err, req, res, next) => {
  // console log only runs in dev, to avoid spamming production logs or leaking server internals
  process.env.NODE_ENV !== 'production' && console.log(`\x1b[31m${err.stack}\x1b[0m`);

  let statusCode = 500;
  let message = 'Internal server error';

  if (err instanceof Error) {
    message = err.message;

    if (err.cause && typeof err.cause === 'object' && 'status' in err.cause) {
      statusCode = err.cause.status as number;
      // falls back to err.status for errors we don't throw ourselves — e.g. express.json()'s
      // body-parser sets `status` directly (not `cause`) on the SyntaxError it throws for malformed JSON
    } else if ('status' in err && typeof err.status === 'number') {
      statusCode = err.status;
      // a schema rule the client broke (e.g. the instrumentsPlayed/role check on save) — without this
      // branch mongoose validation would surface as a 500. The default message prefixes the model name
      // ("User validation failed: ..."), so the individual field messages are joined instead.
    } else if (err instanceof MongooseError.ValidationError) {
      statusCode = 400;
      message = Object.values(err.errors)
        .map((fieldError) => fieldError.message)
        .join(', ');
      // a value that can't be coerced to its schema type, e.g. a malformed ObjectId that reached a query
    } else if (err instanceof MongooseError.CastError) {
      statusCode = 400;
      // the unique index firing. The controller's app-layer lookup normally returns 409 first, but two
      // concurrent signups with the same email can still race past it — this is the actual guarantee.
    } else if ('code' in err && err.code === 11000) {
      statusCode = 409;
      const [duplicatedField] = Object.keys(('keyValue' in err && err.keyValue) || {});
      message = duplicatedField ? `${duplicatedField} already in use` : 'Duplicate value';
    }
  }

  res.status(statusCode).json({ message });
};

export default errorHandler;
