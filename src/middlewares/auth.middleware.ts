import { NextFunction, Request, Response } from 'express';
import { UserRole } from '@prisma/client';
import { verifyAccessToken } from '../utils/jwt';
import { ApiError } from '../utils/ApiError';

/** Requires a valid Bearer access token; attaches the decoded user to req.user. */
export const authenticate = (req: Request, _res: Response, next: NextFunction): void => {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    throw ApiError.unauthorized('Missing or malformed Authorization header');
  }
  const token = header.slice('Bearer '.length).trim();
  req.user = verifyAccessToken(token);
  next();
};

/**
 * Restricts a route to one or more roles. Use after `authenticate`.
 * Example: router.get('/admin', authenticate, authorize('ADMIN'), handler)
 */
export const authorize =
  (...roles: UserRole[]) =>
  (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.user) {
      throw ApiError.unauthorized();
    }
    if (!roles.includes(req.user.role as UserRole)) {
      throw ApiError.forbidden('You do not have permission to access this resource');
    }
    next();
  };
