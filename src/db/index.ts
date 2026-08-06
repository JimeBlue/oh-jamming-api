import mongoose from 'mongoose';
import { MONGODB_URI } from '#config';

// global config so every model's JSON output uses `id` instead of `_id` 
mongoose.set('toJSON', {
  virtuals: true,
  transform: (_doc, converted) => {
    delete (converted as Partial<typeof converted>)._id;
  },
});

// the URI is validated in #config, so there's nothing left to check here
const connectDB = async () => {
  const conn = await mongoose.connect(MONGODB_URI);
  console.log(`MongoDB connected successfully: ${conn.connection.name}`);
};

export default connectDB;
