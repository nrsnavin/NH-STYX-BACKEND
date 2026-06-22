import { Prisma } from '@prisma/client';
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
    ...(search
      ? { name: { contains: search, mode: Prisma.QueryMode.insensitive } }
      : {}),
  };

  const [items, total] = await Promise.all([
    prisma.product.findMany({
      where,
      include: { variants: true, category: { select: { id: true, name: true } } },
      skip: (page - 1) * limit,
      take: limit,
      orderBy: { createdAt: 'desc' },
    }),
    prisma.product.count({ where }),
  ]);

  return {
    items,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    },
  };
}

export async function getProduct(id: string) {
  const product = await prisma.product.findUnique({
    where: { id },
    include: { variants: true, category: true },
  });
  if (!product) {
    throw ApiError.notFound('Product not found');
  }
  return product;
}

interface VariantInput {
  sku: string;
  size?: string;
  color?: string;
  price: number;
  mrp?: number;
  minOrderQty?: number;
  stockQuantity?: number;
  isActive?: boolean;
}

export async function createProduct(input: {
  name: string;
  description?: string;
  brand?: string;
  imageUrls?: string[];
  categoryId: string;
  isActive?: boolean;
  variants: VariantInput[];
}) {
  return prisma.product.create({
    data: {
      name: input.name,
      slug: slugify(`${input.name}-${Date.now().toString(36)}`),
      description: input.description,
      brand: input.brand,
      imageUrls: input.imageUrls ?? [],
      categoryId: input.categoryId,
      isActive: input.isActive ?? true,
      variants: {
        create: input.variants.map((v) => ({
          sku: v.sku,
          size: v.size,
          color: v.color,
          price: v.price,
          mrp: v.mrp,
          minOrderQty: v.minOrderQty ?? 1,
          stockQuantity: v.stockQuantity ?? 0,
          isActive: v.isActive ?? true,
        })),
      },
    },
    include: { variants: true },
  });
}

export async function updateProduct(
  id: string,
  input: {
    name?: string;
    description?: string;
    brand?: string;
    imageUrls?: string[];
    categoryId?: string;
    isActive?: boolean;
  },
) {
  const data: Prisma.ProductUpdateInput = {
    description: input.description,
    brand: input.brand,
    imageUrls: input.imageUrls,
    isActive: input.isActive,
  };
  if (input.name) {
    data.name = input.name;
  }
  if (input.categoryId) {
    data.category = { connect: { id: input.categoryId } };
  }
  return prisma.product.update({ where: { id }, data, include: { variants: true } });
}

export async function deleteProduct(id: string) {
  await prisma.product.delete({ where: { id } });
}
