import { Router } from 'express';
import { login, logout, me, refresh } from '#controllers/auth';
import authenticate from '#middleware/authenticate';
import validateBody from '#middleware/validateBody';
import { loginSchema } from '#schemas/authSchema';

const authRoutes = Router();

// registration is POST /users — see the users router

authRoutes.post('/login', validateBody(loginSchema), login);

// no validateBody: the only input is the refresh cookie, and no body is expected
authRoutes.post('/refresh', refresh);

// DELETE rather than POST — logging out destroys the session
authRoutes.delete('/logout', logout);

authRoutes.get('/me', authenticate, me);

export default authRoutes;
