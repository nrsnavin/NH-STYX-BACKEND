import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { ApiError } from '../../utils/ApiError';

const publicSelect = {
  id: true,
  shopName: true,
  ownerName: true,
  phone: true,
  email: true,
  gstin: true,
  creditLimitPaise: true,
  creditDays: true,
  isActive: true,
  createdAt: true,
} satisfies Prisma.CustomerSelect;

export async function listCustomers(params: { page: number; limit: number; search?: string }) {
  const { page, limit, search } = params;
  const where: Prisma.CustomerWhereInput = search
    ? {
        OR: [
          { shopName: { contains: search, mode: Prisma.QueryMode.insensitive } },
          { ownerName: { contains: search, mode: Prisma.QueryMode.insensitive } },
          { phone: { contains: search } },
        ],
      }
    : {};

  const [items, total] = await Promise.all([
    prisma.customer.findMany({
      where,
      select: { ...publicSelect, _count: { select: { orders: true } } },
      skip: (page - 1) * limit,
      take: limit,
      orderBy: { createdAt: 'desc' },
    }),
    prisma.customer.count({ where }),
  ]);

  return { items, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } };
}

export async function getCustomer(id: string) {
  const customer = await prisma.customer.findUnique({
    where: { id },
    select: {
      ...publicSelect,
      addresses: true,
      _count: { select: { orders: true } },
    },
  });
  if (!customer) throw ApiError.notFound('Customer not found');
  return customer;
}

export async function updateCustomer(
  id: string,
  input: {
    shopName?: string;
    ownerName?: string;
    email?: string | null;
    gstin?: string | null;
    creditLimitPaise?: number;
    creditDays?: number;
    isActive?: boolean;
  },
) {
  await prisma.customer.findUniqueOrThrow({ where: { id } }).catch(() => {
    throw ApiError.notFound('Customer not found');
  });
  return prisma.customer.update({ where: { id }, data: input, select: publicSelect });
}
