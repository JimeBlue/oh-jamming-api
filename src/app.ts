import cookieParser from 'cookie-parser';
import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import mongoose from 'mongoose';
import { CLIENT_URL, PORT } from './config.ts';
import connectDB from './db/index.ts';
import errorHandler from './middleware/errorHandler.ts';
import notFoundHandler from './middleware/notFoundHandler.ts';
import authRoutes from './routes/authRoutes.ts';
import bookingRoutes from './routes/bookingRoutes.ts';
import jamSessionRoutes from './routes/jamSessionRoutes.ts';
import uploadRoutes from './routes/uploadRoutes.ts';
import userRoutes from './routes/userRoutes.ts';

const app = express();

// Render terminates TLS at its proxy and forwards over http, so without this express sees every
// request as insecure and coming from the proxy's IP: `secure` cookies would be refused and the
// rate limiter would count all users as one client. 1 = trust exactly one proxy hop.
app.set('trust proxy', 1);

// the deployed client plus local dev; credentials are needed for the auth cookies
const allowedOrigins = [CLIENT_URL, 'http://localhost:3000'].filter(
  (origin): origin is string => Boolean(origin)
);

// middleware
app.use(helmet());
app.use(
  cors({
    origin: allowedOrigins,
    credentials: true,
    // the browser hides response headers from JS unless they're listed here, and the client needs
    // to read this one to tell an expired access token apart from a dead session
    exposedHeaders: ['WWW-Authenticate'],
  })
);
app.use(express.json());
// populates req.cookies — authenticate and the refresh/logout handlers read the tokens from there
app.use(cookieParser());

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

app.use('/auth', authRoutes);
app.use('/users', userRoutes);
app.use('/jam-sessions', jamSessionRoutes);
app.use('/bookings', bookingRoutes);
app.use('/uploads', uploadRoutes);

// both must stay last: notFoundHandler only runs when no route above matched, and errorHandler is
// the 4-arg middleware every next(err) above ends up in
app.use(notFoundHandler);
app.use(errorHandler);

await connectDB();

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
