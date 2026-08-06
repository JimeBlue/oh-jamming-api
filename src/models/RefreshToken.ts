import { Schema, model } from 'mongoose';
import { REFRESH_TOKEN_TTL } from '#config';

// One document per active session. The browser holds the raw token in a cookie; this collection
// only ever sees its hash, so the rows are useless to anyone who reads the database.
const RefreshTokenSchema = new Schema(
  {
    tokenHash: {
      type: String,
      required: [true, 'tokenHash is required'],
      unique: true,
    },
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'userId is required'],
    },
    // set when the token is rotated away on refresh. The row is kept rather than deleted: a
    // revoked token coming back is how replay is detected, and a deleted row would look identical
    // to a token that never existed.
    revokedAt: {
      type: Date,
      default: null,
    },
    expireAt: {
      type: Date,
      default: () => new Date(Date.now() + REFRESH_TOKEN_TTL * 1000),
    },
  },
  { timestamps: true },
);

// mongo deletes the document once expireAt passes, so old sessions clean themselves up.
// The sweep only runs about once a minute, so the refresh controller still checks expireAt
// explicitly rather than trusting a missing row to mean "expired".
RefreshTokenSchema.index({ expireAt: 1 }, { expireAfterSeconds: 0 });

// refresh looks tokens up by hash (already indexed by `unique`), but revoking a compromised
// session and capping concurrent sessions both query by user
RefreshTokenSchema.index({ userId: 1 });

export default model('RefreshToken', RefreshTokenSchema);
