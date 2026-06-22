import { z } from 'zod';

export const createOrderSchema = z.object({
  body: z.object({
    // Optional — required only when an ADMIN/AGENT places an order on behalf
    // of a customer. CUSTOMERs order for their own profile.
    customerId: z.string().uuid().optional(),
    notes: z.string().optional(),
    shippingAddressId: z.string().uuid().optional(),
    items: z
      .array(
        z.object({
          variantId: z.string().uuid(),
          quantity: z.number().int().positive(),
        }),
      )
      .min(1, 'An order needs at least one item'),
  }),
});

export const listOrdersSchema = z.object({
  query: z.object({
    page: z.coerce.number().int().positive().default(1),
    limit: z.coerce.number().int().positive().max(100).default(20),
    status: z
      .enum([
        'DRAFT',
        'PLACED',
        'CONFIRMED',
        'PACKED',
        'SHIPPED',
        'DELIVERED',
        'CANCELLED',
        'RETURNED',
      ])
      .optional(),
  }),
});

export const orderIdSchema = z.object({
  params: z.object({ id: z.string().uuid() }),
});

export const updateOrderStatusSchema = z.object({
  params: z.object({ id: z.string().uuid() }),
  body: z.object({
    status: z.enum([
      'DRAFT',
      'PLACED',
      'CONFIRMED',
      'PACKED',
      'SHIPPED',
      'DELIVERED',
      'CANCELLED',
      'RETURNED',
    ]),
  }),
});
