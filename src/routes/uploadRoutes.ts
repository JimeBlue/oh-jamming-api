import { Router } from 'express';
import { uploadImage } from '#controllers/uploads';
import authenticate from '#middleware/authenticate';
import parseImageUpload from '#middleware/parseImageUpload';
import requireRole from '#middleware/requireRole';
import uploadLimiter from '#middleware/uploadLimiter';

const uploadRoutes = Router();

// Uploading is its own endpoint rather than a multipart branch of `POST /jam-sessions`, and that is
// the decision this file rests on. A jam session's body is nested — an address object, two arrays
// of objects, numbers with cross-field rules — and multipart flattens all of it to strings, so
// accepting the file on the create route would mean the client JSON-encoding four fields and the
// schema decoding them back. Splitting them keeps `jamSessionInputSchema` a schema over the real
// shape, and leaves this route with exactly one job: bytes in, URL out.
//
// The order matters. Both guards run before formidable is handed the stream, so an anonymous or
// musician request is refused without the file ever being read off the socket, let alone written
// to disk.
uploadRoutes.post(
  '/image',
  uploadLimiter,
  authenticate,
  requireRole('venue'),
  parseImageUpload,
  uploadImage,
);

export default uploadRoutes;
