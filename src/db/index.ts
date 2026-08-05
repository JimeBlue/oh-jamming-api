import mongoose from 'mongoose';

// global config so every model's JSON output uses `id` instead of `_id` 
mongoose.set('toJSON', {
  virtuals: true,
  transform: (_doc, converted) => {
    delete (converted as Partial<typeof converted>)._id;
  },
});

const connectDB = async () => {
  const mongoUri = process.env.MONGODB_URI;
  if (!mongoUri) {
    throw new Error('Missing MONGODB_URI environment variable');
  }

  const conn = await mongoose.connect(mongoUri);
  console.log(`MongoDB connected successfully: ${conn.connection.name}`);
};

export default connectDB;
