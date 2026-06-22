import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { ApiError } from '../../utils/ApiError';
import { slugify } from '../../utils/slug';

export async function listCategories() {
  return prisma.category.findMany({
    where: { parentId: null },
    include: { children: true },
    orderBy: { name: 'asc' },
  });
}

export async function getCategory(id: string) {
  const category = await prisma.category.findUnique({
    where: { id },
    include: { children: true, parent: true },
  });
  if (!category) {
    throw ApiError.notFound('Category not found');
  }
  return category;
}

export async function createCategory(input: {
  name: string;
  description?: string;
  imageUrl?: string;
  parentId?: string;
  isActive?: boolean;
}) {
  return prisma.category.create({
    data: {
      name: input.name,
      slug: slugify(input.name),
      description: input.description,
      imageUrl: input.imageUrl,
      parentId: input.parentId,
      isActive: input.isActive ?? true,
    },
  });
}

export async function updateCategory(
  id: string,
  input: {
    name?: string;
    description?: string;
    imageUrl?: string;
    parentId?: string | null;
    isActive?: boolean;
  },
) {
  const data: Prisma.CategoryUpdateInput = {
    description: input.description,
    imageUrl: input.imageUrl,
    isActive: input.isActive,
  };
  if (input.name) {
    data.name = input.name;
    data.slug = slugify(input.name);
  }
  if (input.parentId !== undefined) {
    data.parent = input.parentId
      ? { connect: { id: input.parentId } }
      : { disconnect: true };
  }
  return prisma.category.update({ where: { id }, data });
}

export async function deleteCategory(id: string) {
  await prisma.category.delete({ where: { id } });
}
