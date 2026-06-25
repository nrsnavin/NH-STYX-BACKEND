import { prisma } from '../../lib/prisma';
import { ApiError } from '../../utils/ApiError';
import { hashPassword, verifyPassword } from '../../utils/password';
import { signAccessToken, signRefreshToken, verifyRefreshToken } from '../../utils/jwt';
import { findStoreForCity } from '../../utils/storeContext';
import { createSignupLead } from '../crm/lead.service';

// Store summary shown to a shop owner ("Shipped from …, <city>").
const storeSelect = {
  select: { id: true, name: true, city: true, code: true, phone: true },
} as const;

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
  city: string;
}) {
  const existing = await prisma.customer.findUnique({ where: { phone: input.phone } });
  if (existing) {
    throw ApiError.conflict('An account with this phone number already exists');
  }

  // Route the shop to the store that serves its city (null if not covered yet).
  const storeId = await findStoreForCity(input.city);

  const customer = await prisma.customer.create({
    data: {
      shopName: input.shopName,
      ownerName: input.ownerName,
      phone: input.phone,
      email: input.email,
      gstin: input.gstin,
      storeId,
      // New shops are PENDING until the serving store's agent approves them.
      status: 'PENDING',
      password: await hashPassword(input.password),
      cart: { create: {} },
    },
    select: {
      id: true,
      shopName: true,
      phone: true,
      status: true,
      store: storeSelect,
    },
  });

  // Surface the sign-up in the CRM pipeline for the serving store's agent.
  await createSignupLead({
    customerId: customer.id,
    shopName: customer.shopName,
    phone: customer.phone,
    contactName: input.ownerName,
    city: input.city,
    storeId,
  });

  // No tokens are issued — the shop cannot sign in until it is approved.
  return {
    status: customer.status,
    store: customer.store,
    message: customer.store
      ? `Your request has been sent to ${customer.store.name}. You can sign in once a store agent approves it.`
      : 'Your request was received. We will assign a store and notify you once approved.',
  };
}

export async function customerLogin(input: { phone: string; password: string }) {
  const customer = await prisma.customer.findUnique({
    where: { phone: input.phone },
    include: { store: storeSelect },
  });
  if (!customer || !customer.password || !(await verifyPassword(input.password, customer.password))) {
    throw ApiError.unauthorized('Invalid phone or password');
  }
  if (!customer.isActive) {
    throw ApiError.forbidden('Your account is disabled. Please contact support.');
  }
  if (customer.status === 'PENDING') {
    throw ApiError.forbidden('Your account is awaiting approval from the store agent.');
  }
  if (customer.status === 'REJECTED') {
    throw ApiError.forbidden(
      customer.rejectionReason
        ? `Your registration was declined: ${customer.rejectionReason}`
        : 'Your registration was declined. Please contact support.',
    );
  }

  return {
    customer: {
      id: customer.id,
      shopName: customer.shopName,
      ownerName: customer.ownerName,
      phone: customer.phone,
      email: customer.email,
      gstin: customer.gstin,
      status: customer.status,
      creditApproved: customer.creditApproved,
      creditLimitPaise: customer.creditLimitPaise,
      creditDays: customer.creditDays,
      store: customer.store,
    },
    accessToken: signAccessToken({ sub: customer.id, type: 'CUSTOMER' }),
    refreshToken: signRefreshToken({ sub: customer.id, type: 'CUSTOMER' }),
  };
}

// Fields a shop owner may edit on their own profile. Empty strings clear the
// nullable ones (e.g. removing a GSTIN).
interface CustomerSelfUpdate {
  shopName?: string;
  ownerName?: string;
  email?: string;
  gstin?: string;
}

export async function customerUpdateSelf(customerId: string, input: CustomerSelfUpdate) {
  const blank = (v?: string) => (v !== undefined ? (v.trim() === '' ? null : v.trim()) : undefined);
  const data = {
    ...(input.shopName !== undefined ? { shopName: input.shopName.trim() } : {}),
    ...(input.ownerName !== undefined ? { ownerName: blank(input.ownerName) } : {}),
    ...(input.email !== undefined ? { email: blank(input.email) } : {}),
    ...(input.gstin !== undefined ? { gstin: blank(input.gstin) } : {}),
  };

  await prisma.customer.update({ where: { id: customerId }, data });
  return customerProfile(customerId);
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
      status: true,
      creditApproved: true,
      creditLimitPaise: true,
      creditDays: true,
      store: storeSelect,
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
