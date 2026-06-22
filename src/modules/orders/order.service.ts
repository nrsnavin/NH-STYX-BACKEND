import { OrderStatus, Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { ApiError } from '../../utils/ApiError';
import { AccessTokenPayload } from '../../utils/jwt';

function generateOrderNumber(): string {
  const date = new Date();
  const ymd = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(
    date.getDate(),
  ).padStart(2, '0')}`;
  const rand = Math.random().toString(36).slice(2, 7).toUpperCase();
  return `NHS-${ymd}-${rand}`;
}

interface CreateOrderInput {
  customerId?: string;
  notes?: string;
  shippingAddressId?: string;
  items: { variantId: string; quantity: number }[];
}

/** Resolves which customer the order belongs to based on the caller's role. */
async function resolveCustomerId(user: AccessTokenPayload, provided?: string): Promise<string> {
  if (user.role === 'CUSTOMER') {
    const profile = await prisma.customerProfile.findUnique({
      where: { userId: user.sub },
      select: { id: true },
    });
    if (!profile) {
      throw ApiError.badRequest('Your account has no customer profile');
    }
    return profile.id;
  }
  // ADMIN / AGENT must specify the target customer.
  if (!provided) {
    throw ApiError.badRequest('customerId is required when ordering on behalf of a customer');
  }
  return provided;
}

export async function createOrder(user: AccessTokenPayload, input: CreateOrderInput) {
  const customerId = await resolveCustomerId(user, input.customerId);

  // Load all referenced variants up front.
  const variantIds = input.items.map((i) => i.variantId);
  const variants = await prisma.productVariant.findMany({
    where: { id: { in: variantIds } },
  });

  if (variants.length !== variantIds.length) {
    throw ApiError.badRequest('One or more product variants do not exist');
  }

  const variantMap = new Map(variants.map((v) => [v.id, v]));

  let subtotal = new Prisma.Decimal(0);
  const orderItemsData = input.items.map((item) => {
    const variant = variantMap.get(item.variantId)!;
    if (!variant.isActive) {
      throw ApiError.badRequest(`Variant ${variant.sku} is not available`);
    }
    if (item.quantity < variant.minOrderQty) {
      throw ApiError.badRequest(
        `Minimum order quantity for ${variant.sku} is ${variant.minOrderQty}`,
      );
    }
    if (variant.stockQuantity < item.quantity) {
      throw ApiError.badRequest(`Insufficient stock for ${variant.sku}`);
    }
    const lineTotal = variant.price.mul(item.quantity);
    subtotal = subtotal.add(lineTotal);
    return {
      variantId: variant.id,
      productName: '', // filled below after product lookup
      sku: variant.sku,
      unitPrice: variant.price,
      quantity: item.quantity,
      lineTotal,
    };
  });

  // Snapshot product names.
  const products = await prisma.product.findMany({
    where: { variants: { some: { id: { in: variantIds } } } },
    select: { name: true, variants: { select: { id: true } } },
  });
  const variantToProductName = new Map<string, string>();
  for (const product of products) {
    for (const v of product.variants) {
      variantToProductName.set(v.id, product.name);
    }
  }
  for (const item of orderItemsData) {
    item.productName = variantToProductName.get(item.variantId) ?? 'Product';
  }

  const total = subtotal; // tax/discount = 0 in this baseline

  // Persist atomically and decrement stock.
  return prisma.$transaction(async (tx) => {
    const order = await tx.order.create({
      data: {
        orderNumber: generateOrderNumber(),
        customerId,
        createdById: user.sub,
        status: OrderStatus.PLACED,
        subtotal,
        total,
        notes: input.notes,
        items: { create: orderItemsData },
      },
      include: { items: true },
    });

    for (const item of input.items) {
      await tx.productVariant.update({
        where: { id: item.variantId },
        data: { stockQuantity: { decrement: item.quantity } },
      });
    }

    return order;
  });
}

/** Role-aware order listing. */
export async function listOrders(
  user: AccessTokenPayload,
  params: { page: number; limit: number; status?: OrderStatus },
) {
  const where: Prisma.OrderWhereInput = {};
  if (params.status) {
    where.status = params.status;
  }

  if (user.role === 'CUSTOMER') {
    const profile = await prisma.customerProfile.findUnique({
      where: { userId: user.sub },
      select: { id: true },
    });
    where.customerId = profile?.id ?? '__none__';
  } else if (user.role === 'AGENT') {
    const agent = await prisma.agentProfile.findUnique({
      where: { userId: user.sub },
      select: { id: true },
    });
    where.agentId = agent?.id ?? '__none__';
  }
  // ADMIN: no additional filter — sees everything.

  const [items, total] = await Promise.all([
    prisma.order.findMany({
      where,
      include: { items: true, customer: { select: { businessName: true } } },
      skip: (params.page - 1) * params.limit,
      take: params.limit,
      orderBy: { createdAt: 'desc' },
    }),
    prisma.order.count({ where }),
  ]);

  return {
    items,
    pagination: {
      page: params.page,
      limit: params.limit,
      total,
      totalPages: Math.ceil(total / params.limit),
    },
  };
}

export async function getOrder(id: string) {
  const order = await prisma.order.findUnique({
    where: { id },
    include: {
      items: true,
      payments: true,
      customer: { select: { businessName: true, user: { select: { email: true } } } },
    },
  });
  if (!order) {
    throw ApiError.notFound('Order not found');
  }
  return order;
}

export async function updateOrderStatus(id: string, status: OrderStatus) {
  return prisma.order.update({ where: { id }, data: { status } });
}
