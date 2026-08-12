import type { RequestHandler } from 'express';
import formidable, { errors as formidableErrors } from 'formidable';

// One image, 5MB. The cap is a decision rather than a default: a listing photo is displayed a few
// hundred pixels wide, and every byte over the wire is held by the container while it streams to
// disk — a 40MB phone panorama is the same picture at forty times the cost.
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

// Turns a multipart request into `req.file`, so the controller only ever deals with a file already
// on disk. It is a separate step because parsing has to happen before anything can read this body
// at all: `express.json()` leaves multipart alone, so `req.body` is empty on this route until
// formidable has run.
const parseImageUpload: RequestHandler = async (req, res, next) => {
  const form = formidable({
    maxFiles: 1,
    maxFileSize: MAX_IMAGE_BYTES,
    // `filter` *skips* the part rather than failing the request, so a PDF reaches the controller
    // as no file at all. That shape is deliberate — "you sent a PDF" and "you sent nothing"
    // deserve the same 400 — and it means the mimetype here is a courtesy check, not a guarantee.
    // A renamed .exe passes this and is then rejected by Cloudinary's own decoder, which is the
    // only layer that actually knows whether the bytes are an image.
    filter: ({ mimetype }) => Boolean(mimetype?.startsWith('image/')),
  });

  try {
    // Only the files half is used: this route carries no text fields. That is the whole reason it
    // exists separately from `POST /jam-sessions` — the session's own fields go up as JSON, which
    // is what keeps `jamSessionInputSchema` a schema over real numbers, arrays and nested objects
    // rather than over multipart's flat strings.
    const [, files] = await form.parse(req);

    req.file = files.image?.[0];

    next();
  } catch (error) {
    next(toClientError(error));
  }
};

// formidable's errors carry the right status but a message written for whoever configured it:
// "options.maxFileSize (5242880 bytes), received 8474114 bytes of file data". Keep the status,
// replace the message.
const toClientError = (error: unknown): unknown => {
  if (!(error instanceof formidableErrors.default)) return error;

  // Two codes for one situation. `maxTotalFileSize` defaults to `maxFileSize`, and it is checked
  // against a running total as the bytes arrive — so a single oversized file trips the *total*
  // limit first and never reaches the per-file one. Matching only `biggerThanMaxFileSize` means
  // the case that actually happens gets the generic message.
  const isTooLarge =
    error.code === formidableErrors.biggerThanMaxFileSize ||
    error.code === formidableErrors.biggerThanTotalMaxFileSize;

  if (isTooLarge) {
    return new Error(`That image is larger than the ${MAX_IMAGE_BYTES / 1024 / 1024}MB limit`, {
      cause: { status: error.httpCode ?? 413 },
    });
  }

  // Everything else here is a malformed body: not multipart, no boundary, more than one file.
  return new Error('That upload could not be read as a single image file', {
    cause: { status: error.httpCode ?? 400 },
  });
};

export default parseImageUpload;
