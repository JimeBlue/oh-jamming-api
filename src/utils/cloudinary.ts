import { v2 as cloudinary } from 'cloudinary';
import { cloudinaryConfig } from '#config';

// Configured once at import. The SDK holds this in module state, so doing it per request would be
// the same three strings written over the top of themselves on every upload.
//
// It would also pick the credentials up on its own from a `CLOUDINARY_URL` variable, and that is
// the shortcut most examples use. Going through config.ts instead keeps every environment variable
// this app reads in the one place that validates them at boot.
if (cloudinaryConfig) cloudinary.config(cloudinaryConfig);

export default cloudinary;
