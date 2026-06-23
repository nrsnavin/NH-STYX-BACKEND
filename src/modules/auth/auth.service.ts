import { prisma } from '../../lib/prisma';
import { ApiError } from '../../utils/ApiError';
import { hashPassword, verifyPassword } from '../../utils/password';
import { signAccessToken, signRefreshToken, verifyRefreshToken } from '../../utils/jwt';

// --- Staff (internal team) ---------------------------------------------------

export async function staffLogin(input: { email: string; password: string }) {
  const user = await prisma.user.findUnique({ where: { email: input.email } });
  if (!user || !(await verifyPassword(input.password, user.password))) {
    throw ApiError.unauthorized('Invalid email or password');
  }
  if (!user.isActive) {
    throw ApiError.forbidden('Your account is disabled. Contact an administrator.');
  }

  return {
    user: { id: user.id, name: user.name, email: user.email, role: user.role },
    accessToken: signAccessToken({ sub: user.id, type: 'STAFF', role: user.role }),
    refreshToken: signRefreshToken({ sub: user.id, type: 'STAFF' }),
  };
}

export async function staffProfile(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, name: true, email: true, phone: true, role: true, isActive: true },
  });
  if (!user) throw ApiError.notFound('User not found');
  return user;
}

// --- Customers (shop owners) -------------------------------------------------

export async function customerRegister(input: {
  shopName: string;
  ownerName?: string;
  phone: string;
  password: string;
  email?: string;
  gstin?: string;
}) {
  const existing = await prisma.customer.findUnique({ where: { phone: input.phone } });
  if (existing) {
    throw ApiError.conflict('An account with this phone number already exists');
  }

  const customer = await prisma.customer.create({
    data: {
      shopName: input.shopName,
      ownerName: input.ownerName,
      phone: input.phone,
      email: input.email,
      gstin: input.gstin,
      password: await hashPassword(input.password),
      cart: { create: {} },
    },
    select: { id: true, shopName: true, ownerName: true, phone: true, email: true, gstin: true },
  });

  return {
    customer,
    accessToken: signAccessToken({ sub: customer.id, type: 'CUSTOMER' }),
    refreshToken: signRefreshToken({ sub: customer.id, type: 'CUSTOMER' }),
  };
}

export async function customerLogin(input: { phone: string; password: string }) {
  const customer = await prisma.customer.findUnique({ where: { phone: input.phone } });
  if (!customer || !customer.password || !(await verifyPassword(input.password, customer.password))) {
    throw ApiError.unauthorized('Invalid phone or password');
  }
  if (!customer.isActive) {
    throw ApiError.forbidden('Your account is disabled. Please contact support.');
  }

  return {
    customer: {
      id: customer.id,
      shopName: customer.shopName,
      ownerName: customer.ownerName,
      phone: customer.phone,
      email: customer.email,
      gstin: customer.gstin,
    },
    accessToken: signAccessToken({ sub: customer.id, type: 'CUSTOMER' }),
    refreshToken: signRefreshToken({ sub: customer.id, type: 'CUSTOMER' }),
  };
}

export async function customerProfile(customerId: string) {
  const customer = await prisma.customer.findUnique({
    where: { id: customerId },
    select: {
      id: true,
      shopName: true,
      ownerName: true,
      phone: true,
      email: true,
      gstin: true,
      creditLimitPaise: true,
      creditDays: true,
    },
  });
  if (!customer) throw ApiError.notFound('Customer not found');
  return customer;
}

// --- Shared ------------------------------------------------------------------

/** Stateless refresh: validate the refresh token and re-issue a token pair. */
export async function refresh(token: string) {
  const payload = verifyRefreshToken(token);

  if (payload.type === 'STAFF') {
    const user = await prisma.user.findUnique({ where: { id: payload.sub } });
    if (!user || !user.isActive) throw ApiError.unauthorized('Account no longer active');
    return {
      accessToken: signAccessToken({ sub: user.id, type: 'STAFF', role: user.role }),
      refreshToken: signRefreshToken({ sub: user.id, type: 'STAFF' }),
    };
  }

  const customer = await prisma.customer.findUnique({ where: { id: payload.sub } });
  if (!customer || !customer.isActive) throw ApiError.unauthorized('Account no longer active');
  return {
    accessToken: signAccessToken({ sub: customer.id, type: 'CUSTOMER' }),
    refreshToken: signRefreshToken({ sub: customer.id, type: 'CUSTOMER' }),
  };
}
