import { unlink } from 'node:fs/promises';
import type { RequestHandler } from 'express';
import { cloudinaryConfig } from '#config';
import cloudinary from '#utils/cloudinary';

// Where jam session photos live in the account, so they can be found, quota-counted and cleaned up
// separately from anything else the project ever uploads.
const UPLOAD_FOLDER = 'oh-jamming/jam-sessions';

// The file is never stored on this server. `parseImageUpload` writes it to the OS temp directory,
// this hands that path to Cloudinary, and the `finally` deletes it — which matters more on Render
// than it looks: the container's disk is ephemeral but not infinite, and a temp file per upload
// with nothing removing them is a slow leak that only shows up weeks later.
//
// The response is a bare `{ url }`, and nothing is written to the database here. The URL becomes a
// jam session's `image` on the POST that follows, so a venue who picks a photo and then abandons
// the wizard leaves an orphaned asset in Cloudinary rather than a half-made session in Mongo.
export const uploadImage: RequestHandler<unknown, { url: string }> = async (req, res, next) => {
  if (!cloudinaryConfig) {
    // 503 rather than 500: the server is fine, this one capability isn't configured. See the note
    // on why these three variables are optional in config.ts.
    next(new Error('Image upload is not configured on this server', { cause: { status: 503 } }));
    return;
  }

  // Either no file part at all, or one the mimetype filter dropped — see parseImageUpload.
  if (!req.file) {
    next(new Error('An image file is required, sent as `image`', { cause: { status: 400 } }));
    return;
  }

  // Read out before the await: `req.file` is an optional property, and TypeScript stops trusting
  // the narrowing above once an async call sits between the check and the use.
  const { filepath } = req.file;

  try {
    const { secure_url } = await cloudinary.uploader.upload(filepath, {
      resource_type: 'image',
      folder: UPLOAD_FOLDER,
      // An incoming transformation, so this is what actually gets *stored* — the 6000px original a
      // phone produced is never kept. A listing photo is displayed a few hundred pixels wide, and
      // 1600 leaves headroom for a retina hero without paying for the other 4400 columns forever.
      // Narrower crops for thumbnails stay available on delivery by editing the URL.
      transformation: [{ width: 1600, crop: 'limit', quality: 'auto' }],
    });

    res.status(201).json({ url: secure_url });
  } catch (error) {
    next(error);
  } finally {
    // Best effort by design: the upload has already succeeded or failed on its own terms, and a
    // temp file that resists deletion is not a reason to turn a working upload into a 500.
    await unlink(filepath).catch(() => {});
  }
};
