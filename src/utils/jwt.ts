import crypto from 'node:crypto';
import jwt, { JwtPayload, SignOptions } from 'jsonwebtoken';
import { env } from '../config/env';
import { ApiError } from './ApiError';

export type UserRoleClaim = 'ADMIN' | 'AGENT' | 'CUSTOMER';

export interface AccessTokenPayload {
  sub: string; // user id
  email: string;
  role: UserRoleClaim;
}

const accessOptions: SignOptions = {
  expiresIn: env.JWT_ACCESS_EXPIRES_IN as SignOptions['expiresIn'],
};

const refreshOptions: SignOptions = {
  expiresIn: env.JWT_REFRESH_EXPIRES_IN as SignOptions['expiresIn'],
};

export const signAccessToken = (payload: AccessTokenPayload): string =>
  jwt.sign(payload, env.JWT_ACCESS_SECRET, accessOptions);

export const signRefreshToken = (payload: { sub: string }): string =>
  jwt.sign(payload, env.JWT_REFRESH_SECRET, refreshOptions);

export const verifyAccessToken = (token: string): AccessTokenPayload => {
  try {
    return jwt.verify(token, env.JWT_ACCESS_SECRET) as AccessTokenPayload & JwtPayload;
  } catch {
    throw ApiError.unauthorized('Invalid or expired access token');
  }
};

export const verifyRefreshToken = (token: string): { sub: string } => {
  try {
    return jwt.verify(token, env.JWT_REFRESH_SECRET) as { sub: string } & JwtPayload;
  } catch {
    throw ApiError.unauthorized('Invalid or expired refresh token');
  }
};

/** Refresh tokens are stored hashed (never in plaintext). */
export const hashToken = (token: string): string =>
  crypto.createHash('sha256').update(token).digest('hex');

/** Reads the `exp` claim of a signed token and returns it as a Date. */
export const getTokenExpiry = (token: string): Date => {
  const decoded = jwt.decode(token) as JwtPayload | null;
  if (!decoded?.exp) {
    // Fallback: 7 days from now.
    return new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  }
  return new Date(decoded.exp * 1000);
};
