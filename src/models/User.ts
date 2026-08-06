import bcrypt from 'bcrypt';
import { Schema, model } from 'mongoose';

const SALT_ROUNDS = 10;

const UserSchema = new Schema(
  {
    firstName: {
      type: String,
      required: [true, 'firstName is required'],
      minLength: [2, 'min length is 2 chars'],
      maxLength: [255, 'max length is 255 chars'],
      trim: true,
    },
    lastName: {
      type: String,
      required: [true, 'lastName is required'],
      minLength: [2, 'min length is 2 chars'],
      maxLength: [255, 'max length is 255 chars'],
      trim: true,
    },
    email: {
      type: String,
      required: [true, 'email is required'],
      unique: true,
      minLength: [5, 'min length is 5 chars'],
      // login looks users up by email, so it has to be stored in one canonical form
      lowercase: true,
      trim: true,
    },
    // holds the bcrypt hash once the pre('save') hook below has run
    password: {
      type: String,
      required: [true, 'password is required'],
      // no minLength here on purpose — see the note on the hook below
    },
    role: {
      type: String,
      required: [true, 'role is required'],
      enum: {
        values: ['venue', 'musician'],
        message: 'role must be either venue or musician',
      },
    },
    // musicians only — a venue account has no instruments
    instrumentsPlayed: {
      type: [String],
      validate: [
        function (this: { role?: string }, instruments: string[]) {
          return this.role === 'musician' || instruments.length === 0;
        },
        'only musicians can have instrumentsPlayed',
      ],
    },
  },
  { timestamps: true },
);

// NOTE: pre('save') hooks run BEFORE mongoose validation, not after. That means a minLength on the
// password field would only ever measure the 60-char hash, never the plaintext — which is why the
// field above has none. Password length is enforced by the Zod input schema instead.
// isModified guards against re-hashing an already-hashed password on every unrelated update.
UserSchema.pre('save', async function () {
  if (!this.isModified('password')) return;

  this.password = await bcrypt.hash(this.password, SALT_ROUNDS);
});

export default model('User', UserSchema);
