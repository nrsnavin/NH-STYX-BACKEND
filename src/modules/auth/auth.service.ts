import { UserStatus } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { ApiError } from '../../utils/ApiError';
import { hashPassword, verifyPassword } from '../../utils/password';
import {
  getTokenExpiry,
  hashToken,
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
  UserRoleClaim,
} from '../../utils/jwt';
import { LoginInput, RegisterInput } from './auth.validation';

interface AuthUser {
  id: string;
  email: string;
  role: UserRoleClaim;
}

async function issueTokens(user: AuthUser) {
  const accessToken = signAccessToken({ sub: user.id, email: user.email, role: user.role });
  const refreshToken = signRefreshToken({ sub: user.id });

  await prisma.refreshToken.create({
    data: {
      userId: user.id,
      tokenHash: hashToken(refreshToken),
      expiresAt: getTokenExpiry(refreshToken),
    },
  });

  return { accessToken, refreshToken };
}

/** Self-service registration for a store/boutique owner (CUSTOMER role). */
export async function register(input: RegisterInput) {
  const existing = await prisma.user.findUnique({ where: { email: input.email } });
  if (existing) {
    throw ApiError.conflict('An account with this email already exists');
  }

  const passwordHash = await hashPassword(input.password);

  const user = await prisma.user.create({
    data: {
      email: input.email,
      phone: input.phone,
      passwordHash,
      fullName: input.fullName,
      role: 'CUSTOMER',
      status: UserStatus.ACTIVE,
      customerProfile: {
        create: {
          businessName: input.businessName,
          gstNumber: input.gstNumber,
          businessType: input.businessType,
          cart: { create: {} },
        },
      },
    },
    select: { id: true, email: true, role: true, fullName: true, status: true },
  });

  const tokens = await issueTokens({ id: user.id, email: user.email, role: user.role });
  return { user, ...tokens };
}

export async function login(input: LoginInput) {
  const user = await prisma.user.findUnique({ where: { email: input.email } });
  if (!user) {
    throw ApiError.unauthorized('Invalid email or password');
  }

  const valid = await verifyPassword(input.password, user.passwordHash);
  if (!valid) {
    throw ApiError.unauthorized('Invalid email or password');
  }

  if (user.status === UserStatus.SUSPENDED) {
    throw ApiError.forbidden('Your account has been suspended. Please contact support.');
  }

  const tokens = await issueTokens({ id: user.id, email: user.email, role: user.role });
  return {
    user: {
      id: user.id,
      email: user.email,
      fullName: user.fullName,
      role: user.role,
      status: user.status,
    },
    ...tokens,
  };
}

/** Rotates a refresh token: revokes the old one and issues a fresh pair. */
export async function refresh(token: string) {
  const payload = verifyRefreshToken(token);
  const tokenHash = hashToken(token);

  const stored = await prisma.refreshToken.findUnique({ where: { tokenHash } });
  if (!stored || stored.revokedAt || stored.expiresAt < new Date()) {
    throw ApiError.unauthorized('Refresh token is invalid or expired');
  }

  const user = await prisma.user.findUnique({ where: { id: payload.sub } });
  if (!user) {
    throw ApiError.unauthorized('User no longer exists');
  }

  // Revoke the used token (rotation).
  await prisma.refreshToken.update({
    where: { id: stored.id },
    data: { revokedAt: new Date() },
  });

  const tokens = await issueTokens({ id: user.id, email: user.email, role: user.role });
  return tokens;
}

export async function logout(token: string) {
  const tokenHash = hashToken(token);
  await prisma.refreshToken.updateMany({
    where: { tokenHash, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

export async function getProfile(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      email: true,
      phone: true,
      fullName: true,
      role: true,
      status: true,
      customerProfile: {
        select: { id: true, businessName: true, gstNumber: true, businessType: true },
      },
      agentProfile: {
        select: { id: true, employeeCode: true, region: true },
      },
    },
  });
  if (!user) {
    throw ApiError.notFound('User not found');
  }
  return user;
}
