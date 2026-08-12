import type { File } from 'formidable';

// What the access token carries. JWT payloads are signed, not encrypted — anyone holding the
// token can read this — so it holds an id and a role and nothing else.
export type AuthPayload = {
  userId: string;
  role: 'venue' | 'musician';
};

// `authenticate` sets req.user once it has verified the token; `requireRole` and the controllers
// read it. Optional because the property is absent on every unauthenticated request.
declare global {
  namespace Express {
    interface Request {
      user?: AuthPayload;
      // Set by `parseImageUpload`, read by the uploads controller. Optional for the same reason
      // `user` is: on every route that isn't an upload there is no file, and on an upload route
      // the part may have been dropped by the mimetype filter.
      file?: File;
    }
  }
}
