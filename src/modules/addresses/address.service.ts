import { prisma } from '../../lib/prisma';
import { ApiError } from '../../utils/ApiError';

interface AddressInput {
  label?: string;
  line1: string;
  line2?: string;
  city: string;
  state: string;
  stateCode?: string;
  pincode: string;
  isDefault?: boolean;
}

export async function listAddresses(customerId: string) {
  return prisma.address.findMany({
    where: { customerId },
    orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }],
  });
}

async function ensureOwned(customerId: string, addressId: string) {
  const address = await prisma.address.findUnique({ where: { id: addressId } });
  if (!address || address.customerId !== customerId) {
    throw ApiError.notFound('Address not found');
  }
  return address;
}

export async function createAddress(customerId: string, input: AddressInput) {
  // First address is default by default.
  const count = await prisma.address.count({ where: { customerId } });
  const makeDefault = input.isDefault || count === 0;

  return prisma.$transaction(async (tx) => {
    if (makeDefault) {
      await tx.address.updateMany({ where: { customerId }, data: { isDefault: false } });
    }
    return tx.address.create({
      data: { ...input, isDefault: makeDefault, customerId },
    });
  });
}

export async function updateAddress(customerId: string, id: string, input: Partial<AddressInput>) {
  await ensureOwned(customerId, id);
  return prisma.$transaction(async (tx) => {
    if (input.isDefault) {
      await tx.address.updateMany({ where: { customerId }, data: { isDefault: false } });
    }
    return tx.address.update({ where: { id }, data: input });
  });
}

export async function deleteAddress(customerId: string, id: string) {
  await ensureOwned(customerId, id);
  await prisma.address.delete({ where: { id } });
}
