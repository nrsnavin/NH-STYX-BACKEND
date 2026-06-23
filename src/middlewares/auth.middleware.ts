import { NextFunction, Request, Response } from 'express';
import { Role } from '@prisma/client';
import { verifyAccessToken } from '../utils/jwt';
import { ApiError } from '../utils/ApiError';

/** Requires a valid Bearer access token; attaches the decoded actor to req.auth. */
export const authenticate = (req: Request, _res: Response, next: NextFunction): void => {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    throw ApiError.unauthorized('Missing or malformed Authorization header');
  }
  const token = header.slice('Bearer '.length).trim();
  req.auth = verifyAccessToken(token);
  next();
};

/** Restricts a route to internal staff (User: ADMIN/AGENT). */
export const requireStaff = (req: Request, _res: Response, next: NextFunction): void => {
  if (!req.auth || req.auth.type !== 'STAFF') {
    throw ApiError.forbidden('Staff access only');
  }
  next();
};

/** Restricts a route to shop-owner customers. */
export const requireCustomer = (req: Request, _res: Response, next: NextFunction): void => {
  if (!req.auth || req.auth.type !== 'CUSTOMER') {
    throw ApiError.forbidden('Customer access only');
  }
  next();
};

/**
 * Restricts a route to specific staff roles. Implies `requireStaff`.
 * Example: router.post('/', authenticate, authorize('ADMIN'), handler)
 */
export const authorize =
  (...roles: Role[]) =>
  (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.auth || req.auth.type !== 'STAFF') {
      throw ApiError.forbidden('Staff access only');
    }
    if (!req.auth.role || !roles.includes(req.auth.role)) {
      throw ApiError.forbidden('You do not have permission to access this resource');
    }
    next();
  };
