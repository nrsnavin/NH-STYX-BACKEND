import jwt, { JwtPayload, SignOptions } from 'jsonwebtoken';
import { Role } from '@prisma/client';
import { env } from '../config/env';
import { ApiError } from './ApiError';

/** Who the token belongs to: internal staff or a shop-owner customer. */
export type ActorType = 'STAFF' | 'CUSTOMER';

export interface AccessTokenPayload {
  sub: string; // User.id (staff) or Customer.id
  type: ActorType;
  role?: Role; // only for STAFF (ADMIN | AGENT)
}

export interface RefreshTokenPayload {
  sub: string;
  type: ActorType;
}

const accessOptions: SignOptions = {
  expiresIn: env.JWT_ACCESS_EXPIRES_IN as SignOptions['expiresIn'],
};

const refreshOptions: SignOptions = {
  expiresIn: env.JWT_REFRESH_EXPIRES_IN as SignOptions['expiresIn'],
};

export const signAccessToken = (payload: AccessTokenPayload): string =>
  jwt.sign(payload, env.JWT_ACCESS_SECRET, accessOptions);

export const signRefreshToken = (payload: RefreshTokenPayload): string =>
  jwt.sign(payload, env.JWT_REFRESH_SECRET, refreshOptions);

export const verifyAccessToken = (token: string): AccessTokenPayload => {
  try {
    return jwt.verify(token, env.JWT_ACCESS_SECRET) as AccessTokenPayload & JwtPayload;
  } catch {
    throw ApiError.unauthorized('Invalid or expired access token');
  }
};

export const verifyRefreshToken = (token: string): RefreshTokenPayload => {
  try {
    return jwt.verify(token, env.JWT_REFRESH_SECRET) as RefreshTokenPayload & JwtPayload;
  } catch {
    throw ApiError.unauthorized('Invalid or expired refresh token');
  }
};
