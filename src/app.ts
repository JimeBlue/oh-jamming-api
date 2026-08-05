import cors from 'cors';
import express from 'express';
import mongoose from 'mongoose';
import connectDB from './db/index.ts';

const app = express();
const port = process.env.PORT || 8080;

// the deployed client plus local dev; credentials are needed for the auth cookies
const allowedOrigins = [process.env.CLIENT_URL, 'http://localhost:3000'].filter(
  (origin): origin is string => Boolean(origin)
);

// middleware
app.use(cors({ origin: allowedOrigins, credentials: true }));
app.use(express.json());

app.get('/', (req, res) => {
  res.json({ status: 'ok' });
});

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    db: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
    timestamp: new Date().toISOString(),
  });
});

// routes go here

await connectDB();

app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});
