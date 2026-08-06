import { createHash, randomUUID } from 'node:crypto';

// the raw refresh token. It goes into the cookie and is never stored anywhere on the server.
export const generateRefreshToken = (): string => randomUUID();

// SHA-256, hex. Only the hash is stored, so a leaked database dump can't be used to log in.
//
// Deliberately not bcrypt, unlike the user's password: this value is 122 bits of random, not a
// human-chosen string, so there is nothing for an attacker to guess and no need to slow them
// down. It also has to be *deterministic* — every refresh looks the token up by its hash, which
// a salted algorithm makes impossible.
export const hashToken = (token: string): string =>
  createHash('sha256').update(token).digest('hex');
