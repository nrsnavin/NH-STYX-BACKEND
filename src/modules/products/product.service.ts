import { Prisma, ProductUnit } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { ApiError } from '../../utils/ApiError';
import { slugify } from '../../utils/slug';

interface ListParams {
  page: number;
  limit: number;
  search?: string;
  categoryId?: string;
  isActive?: boolean;
}

export async function listProducts(params: ListParams) {
  const { page, limit, search, categoryId, isActive } = params;
  const where: Prisma.ProductWhereInput = {
    ...(categoryId ? { categoryId } : {}),
    ...(isActive !== undefined ? { isActive } : {}),
    ...(search ? { name: { contains: search, mode: Prisma.QueryMode.insensitive } } : {}),
  };

  const [items, total] = await Promise.all([
    prisma.product.findMany({
      where,
      include: {
        priceTiers: { orderBy: { minQty: 'asc' } },
        category: { select: { id: true, name: true } },
      },
      skip: (page - 1) * limit,
      take: limit,
      orderBy: { createdAt: 'desc' },
    }),
    prisma.product.count({ where }),
  ]);

  return {
    items,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  };
}

export async function getProduct(id: string) {
  const product = await prisma.product.findUnique({
    where: { id },
    include: { priceTiers: { orderBy: { minQty: 'asc' } }, category: true },
  });
  if (!product) throw ApiError.notFound('Product not found');
  return product;
}

interface TierInput {
  minQty: number;
  pricePaise: number;
}

interface CreateProductInput {
  name: string;
  description?: string;
  brand?: string;
  categoryId: string;
  unit?: ProductUnit;
  hsnCode?: string;
  gstRatePercent?: number;
  mrpPaise?: number;
  pricePaise: number;
  moqQty?: number;
  stockQty?: number;
  imageUrl?: string;
  isActive?: boolean;
  priceTiers?: TierInput[];
}

export async function createProduct(input: CreateProductInput) {
  return prisma.product.create({
    data: {
      name: input.name,
      slug: slugify(`${input.name}-${Date.now().toString(36)}`),
      description: input.description,
      brand: input.brand,
      categoryId: input.categoryId,
      unit: input.unit ?? ProductUnit.PIECE,
      hsnCode: input.hsnCode,
      gstRatePercent: input.gstRatePercent ?? 0,
      mrpPaise: input.mrpPaise,
      pricePaise: input.pricePaise,
      moqQty: input.moqQty ?? 1,
      stockQty: input.stockQty ?? 0,
      imageUrl: input.imageUrl,
      isActive: input.isActive ?? true,
      priceTiers: input.priceTiers?.length
        ? { create: input.priceTiers.map((t) => ({ minQty: t.minQty, pricePaise: t.pricePaise })) }
        : undefined,
    },
    include: { priceTiers: { orderBy: { minQty: 'asc' } } },
  });
}

export async function updateProduct(
  id: string,
  input: Partial<CreateProductInput> & { mrpPaise?: number | null },
) {
  const { priceTiers, name, categoryId, ...rest } = input;

  return prisma.$transaction(async (tx) => {
    const data: Prisma.ProductUpdateInput = {
      description: rest.description,
      brand: rest.brand,
      unit: rest.unit,
      hsnCode: rest.hsnCode,
      gstRatePercent: rest.gstRatePercent,
      mrpPaise: rest.mrpPaise,
      pricePaise: rest.pricePaise,
      moqQty: rest.moqQty,
      stockQty: rest.stockQty,
      imageUrl: rest.imageUrl,
      isActive: rest.isActive,
    };
    if (name) {
      data.name = name;
      data.slug = slugify(`${name}-${Date.now().toString(36)}`);
    }
    if (categoryId) {
      data.category = { connect: { id: categoryId } };
    }

    const product = await tx.product.update({ where: { id }, data });

    // When priceTiers is supplied, replace the whole set.
    if (priceTiers) {
      await tx.priceTier.deleteMany({ where: { productId: id } });
      if (priceTiers.length) {
        await tx.priceTier.createMany({
          data: priceTiers.map((t) => ({ productId: id, minQty: t.minQty, pricePaise: t.pricePaise })),
        });
      }
    }

    return tx.product.findUniqueOrThrow({
      where: { id: product.id },
      include: { priceTiers: { orderBy: { minQty: 'asc' } } },
    });
  });
}

export async function deleteProduct(id: string) {
  await prisma.product.delete({ where: { id } });
}
