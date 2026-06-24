import { Prisma, Role } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { ApiError } from '../../utils/ApiError';
import { hashPassword } from '../../utils/password';

const select = {
  id: true,
  name: true,
  email: true,
  phone: true,
  role: true,
  isActive: true,
  storeId: true,
  store: { select: { id: true, name: true, city: true, code: true } },
  createdAt: true,
} satisfies Prisma.UserSelect;

export async function listUsers(params: { search?: string; role?: Role }) {
  const where: Prisma.UserWhereInput = {
    ...(params.role ? { role: params.role } : {}),
    ...(params.search
      ? {
          OR: [
            { name: { contains: params.search, mode: Prisma.QueryMode.insensitive } },
            { email: { contains: params.search, mode: Prisma.QueryMode.insensitive } },
          ],
        }
      : {}),
  };
  return prisma.user.findMany({ where, select, orderBy: { createdAt: 'desc' } });
}

export async function createUser(input: {
  name: string;
  email: string;
  password: string;
  role: Role;
  phone?: string;
  storeId?: string | null;
}) {
  const exists = await prisma.user.findUnique({ where: { email: input.email } });
  if (exists) throw ApiError.conflict('A staff member with this email already exists');
  return prisma.user.create({
    data: {
      name: input.name,
      email: input.email,
      password: await hashPassword(input.password),
      role: input.role,
      phone: input.phone,
      // Agents belong to a store; admins never do.
      storeId: input.role === Role.AGENT ? input.storeId ?? null : null,
    },
    select,
  });
}

export async function updateUser(
  id: string,
  input: {
    name?: string;
    phone?: string | null;
    role?: Role;
    storeId?: string | null;
    isActive?: boolean;
    password?: string;
  },
) {
  await prisma.user.findUniqueOrThrow({ where: { id } }).catch(() => {
    throw ApiError.notFound('Staff member not found');
  });
  const data: Prisma.UserUpdateInput = {
    name: input.name,
    phone: input.phone,
    isActive: input.isActive,
  };
  if (input.role) {
    data.role = input.role;
    if (input.role === Role.ADMIN) data.store = { disconnect: true };
  }
  if (input.storeId !== undefined && input.role !== Role.ADMIN) {
    data.store = input.storeId ? { connect: { id: input.storeId } } : { disconnect: true };
  }
  if (input.password) data.password = await hashPassword(input.password);

  return prisma.user.update({ where: { id }, data, select });
}
