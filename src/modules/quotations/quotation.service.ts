import {
  OrderPaymentStatus,
  OrderStatus,
  PaymentMethod,
  PaymentStatus,
  Prisma,
  QuotationStatus,
  StockMovementType,
} from '@prisma/client';
import { prisma, tenantTransaction } from '../../lib/prisma';
import { ApiError } from '../../utils/ApiError';
import { computeLineTax, isIntraState, resolveUnitPrice } from '../../utils/pricing';
import { recordOrderEvent, recordStockMovement } from '../../utils/ledger';
import { getStaffStoreId } from '../../utils/storeContext';
import { nextOrderNumber } from '../orders/order.service';

const quotationInclude = {
  customer: {
    select: {
      id: true,
      shopName: true,
      phone: true,
      gstin: true,
      creditApproved: true,
      creditLimitPaise: true,
      creditDays: true,
    },
  },
  lead: { select: { id: true, shopName: true, phone: true } },
  store: { select: { id: true, name: true, city: true } },
  createdBy: { select: { id: true, name: true } },
  items: true,
} satisfies Prisma.QuotationInclude;

interface ItemInput {
  productId: string;
  variantId?: string | null;
  quantity: number;
  unitPricePaise?: number; // negotiated override; falls back to the store price
}

async function nextQuoteNumber(tx: Prisma.TransactionClient): Promise<string> {
  const [{ nextval }] = await tx.$queryRaw<{ nextval: bigint }[]>`
    SELECT nextval('quotation_number_seq')`;
  return `QUO-${new Date().getFullYear()}-${String(Number(nextval)).padStart(5, '0')}`;
}

/**
 * Resolve the serving store + GST context for a quote's recipient (a customer
 * or a lead). Tax is indicative on the quote — recomputed against the real
 * delivery address at conversion.
 */
async function contextFor(opts: {
  customerId?: string | null;
  leadId?: string | null;
  staffStoreId: string | null;
}) {
  let storeId: string | null = null;
  let buyerStateCode: string | null = null;
  let buyerStateName: string | null = null;

  if (opts.customerId) {
    const customer = await prisma.customer.findUnique({
      where: { id: opts.customerId },
      include: { addresses: { orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }], take: 1 } },
    });
    if (!customer) throw ApiError.notFound('Customer not found');
    storeId = customer.storeId;
    const addr = customer.addresses[0];
    buyerStateCode = addr?.stateCode ?? null;
    buyerStateName = addr?.state ?? null;
  } else if (opts.leadId) {
    const lead = await prisma.lead.findUnique({ where: { id: opts.leadId } });
    if (!lead) throw ApiError.notFound('Lead not found');
    storeId = lead.storeId;
  }

  if (!storeId) {
    throw ApiError.badRequest('This shop is not linked to a store yet — assign a store first.');
  }
  if (opts.staffStoreId && opts.staffStoreId !== storeId) {
    throw ApiError.forbidden('This shop belongs to another store');
  }

  const store = await prisma.store.findUniqueOrThrow({ where: { id: storeId } });
  const intra = isIntraState(buyerStateCode, buyerStateName, store.stateCode, store.state);
  const placeOfSupply = buyerStateName ?? store.state;
  return { store, intra, placeOfSupply };
}

/** Price + GST-snapshot the requested lines against a store (no stock/MOQ
 *  enforcement — a quote is a proposal; price may be negotiated). */
async function buildItems(storeId: string, intra: boolean, items: ItemInput[]) {
  const productIds = [...new Set(items.map((i) => i.productId))];
  const products = await prisma.product.findMany({ where: { id: { in: productIds } } });
  const productById = new Map(products.map((p) => [p.id, p]));

  const storeProducts = await prisma.storeProduct.findMany({
    where: { storeId, productId: { in: productIds } },
    include: { priceTiers: true },
  });
  const spByProduct = new Map(storeProducts.map((sp) => [sp.productId, sp]));

  const variantIds = items.filter((i) => i.variantId).map((i) => i.variantId!);
  const variants = variantIds.length
    ? await prisma.productVariant.findMany({ where: { id: { in: variantIds } } })
    : [];
  const variantById = new Map(variants.map((v) => [v.id, v]));
  const storeVariants = variantIds.length
    ? await prisma.storeVariant.findMany({ where: { storeId, variantId: { in: variantIds } } })
    : [];
  const svByVariant = new Map(storeVariants.map((sv) => [sv.variantId, sv]));

  let subtotalPaise = 0;
  let cgstPaise = 0;
  let sgstPaise = 0;
  let igstPaise = 0;

  const rows = items.map(({ productId, variantId, quantity, unitPricePaise }) => {
    const product = productById.get(productId);
    if (!product) throw ApiError.badRequest('A selected product was not found');

    let resolved: number | null = unitPricePaise ?? null;
    let variantName: string | null = null;

    if (variantId) {
      const variant = variantById.get(variantId);
      if (!variant || variant.productId !== productId) {
        throw ApiError.badRequest(`Invalid option for ${product.name}`);
      }
      variantName = variant.name;
      if (resolved == null) resolved = svByVariant.get(variantId)?.pricePaise ?? null;
    } else {
      const sp = spByProduct.get(productId);
      if (resolved == null) resolved = sp ? resolveUnitPrice(sp.pricePaise, sp.priceTiers, quantity) : null;
    }

    if (resolved == null) {
      throw ApiError.badRequest(
        `No price for ${product.name}${variantName ? ` (${variantName})` : ''} — set a unit price`,
      );
    }

    const lineSubtotalPaise = resolved * quantity;
    const tax = computeLineTax(lineSubtotalPaise, product.gstRatePercent, intra);
    subtotalPaise += lineSubtotalPaise;
    cgstPaise += tax.cgstPaise;
    sgstPaise += tax.sgstPaise;
    igstPaise += tax.igstPaise;

    return {
      productId,
      variantId: variantId ?? null,
      productName: product.name,
      variantName,
      hsnCode: product.hsnCode,
      unit: product.unit,
      quantity,
      unitPricePaise: resolved,
      gstRatePercent: product.gstRatePercent,
      lineSubtotalPaise,
      cgstPaise: tax.cgstPaise,
      sgstPaise: tax.sgstPaise,
      igstPaise: tax.igstPaise,
      lineTotalPaise: lineSubtotalPaise + tax.taxPaise,
    };
  });

  return { rows, subtotalPaise, cgstPaise, sgstPaise, igstPaise };
}

// ---- Queries ----------------------------------------------------------------

/**
 * Lazily expire quotes whose validity has lapsed. There's no scheduler, so we
 * sweep on read: any open (draft/sent) quote past its validUntil flips to
 * EXPIRED. Accepted/converted/closed quotes are left alone.
 */
export async function expireOverdue() {
  await prisma.quotation.updateMany({
    where: {
      status: { in: [QuotationStatus.DRAFT, QuotationStatus.SENT] },
      validUntil: { lt: new Date(), not: null },
    },
    data: { status: QuotationStatus.EXPIRED },
  });
}

export async function listQuotations(params: {
  page: number;
  limit: number;
  status?: QuotationStatus;
  search?: string;
  customerId?: string;
  storeId?: string | null; // agent scope; null = admin (all)
}) {
  const { page, limit, status, search, customerId, storeId } = params;
  await expireOverdue();
  const where: Prisma.QuotationWhereInput = {
    ...(storeId ? { storeId } : {}),
    ...(status ? { status } : {}),
    ...(customerId ? { customerId } : {}),
    ...(search
      ? {
          OR: [
            { quoteNumber: { contains: search, mode: Prisma.QueryMode.insensitive } },
            { customer: { shopName: { contains: search, mode: Prisma.QueryMode.insensitive } } },
            { lead: { shopName: { contains: search, mode: Prisma.QueryMode.insensitive } } },
          ],
        }
      : {}),
  };

  const [items, total] = await Promise.all([
    prisma.quotation.findMany({
      where,
      include: quotationInclude,
      skip: (page - 1) * limit,
      take: limit,
      orderBy: { createdAt: 'desc' },
    }),
    prisma.quotation.count({ where }),
  ]);
  return { items, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } };
}

export async function getQuotation(id: string) {
  await expireOverdue();
  const quote = await prisma.quotation.findUnique({ where: { id }, include: quotationInclude });
  if (!quote) throw ApiError.notFound('Quotation not found');
  return quote;
}

// ---- Customer self-service --------------------------------------------------

/** The shop's own quotes (everything they've been sent — drafts excluded). */
export async function listForCustomer(customerId: string) {
  await expireOverdue();
  return prisma.quotation.findMany({
    where: { customerId, status: { not: QuotationStatus.DRAFT } },
    include: quotationInclude,
    orderBy: { createdAt: 'desc' },
  });
}

export async function getForCustomer(customerId: string, id: string) {
  await expireOverdue();
  const quote = await prisma.quotation.findUnique({ where: { id }, include: quotationInclude });
  if (!quote || quote.customerId !== customerId || quote.status === QuotationStatus.DRAFT) {
    throw ApiError.notFound('Quotation not found');
  }
  return quote;
}

/** A shop accepts or declines a quote it was sent (only while still SENT). */
export async function respondToQuote(customerId: string, id: string, action: 'ACCEPT' | 'DECLINE') {
  const quote = await prisma.quotation.findUnique({ where: { id } });
  if (!quote || quote.customerId !== customerId) throw ApiError.notFound('Quotation not found');
  if (quote.status !== QuotationStatus.SENT) {
    throw ApiError.badRequest('This quotation can no longer be responded to');
  }
  return prisma.quotation.update({
    where: { id },
    data: { status: action === 'ACCEPT' ? QuotationStatus.ACCEPTED : QuotationStatus.DECLINED },
    include: quotationInclude,
  });
}

// ---- Mutations --------------------------------------------------------------

interface CreateInput {
  customerId?: string;
  leadId?: string;
  title?: string;
  notes?: string;
  validUntil?: string | null;
  discountPaise?: number;
  items: ItemInput[];
}

export async function createQuotation(input: CreateInput, staff: { id: string; storeId: string | null }) {
  const ctx = await contextFor({ customerId: input.customerId, leadId: input.leadId, staffStoreId: staff.storeId });
  const built = await buildItems(ctx.store.id, ctx.intra, input.items);
  const taxedTotal = built.subtotalPaise + built.cgstPaise + built.sgstPaise + built.igstPaise;
  const discountPaise = Math.min(input.discountPaise ?? 0, taxedTotal);

  return tenantTransaction(async (tx) => {
    const quoteNumber = await nextQuoteNumber(tx);
    return tx.quotation.create({
      data: {
        quoteNumber,
        status: QuotationStatus.DRAFT,
        title: input.title,
        notes: input.notes,
        validUntil: input.validUntil ? new Date(input.validUntil) : null,
        customerId: input.customerId ?? null,
        leadId: input.leadId ?? null,
        storeId: ctx.store.id,
        createdById: staff.id,
        placeOfSupply: ctx.placeOfSupply,
        sellerStateCode: ctx.store.stateCode,
        subtotalPaise: built.subtotalPaise,
        cgstPaise: built.cgstPaise,
        sgstPaise: built.sgstPaise,
        igstPaise: built.igstPaise,
        discountPaise,
        totalPaise: taxedTotal - discountPaise,
        items: { create: built.rows },
      },
      include: quotationInclude,
    });
  });
}

interface UpdateInput {
  title?: string | null;
  notes?: string | null;
  validUntil?: string | null;
  discountPaise?: number;
  items?: ItemInput[];
}

export async function updateQuotation(id: string, input: UpdateInput) {
  const existing = await prisma.quotation.findUnique({ where: { id } });
  if (!existing) throw ApiError.notFound('Quotation not found');
  if (existing.status !== QuotationStatus.DRAFT) {
    throw ApiError.badRequest('Only draft quotations can be edited');
  }

  const validUntil =
    input.validUntil === undefined ? undefined : input.validUntil ? new Date(input.validUntil) : null;
  const discountInput = input.discountPaise ?? existing.discountPaise;

  // Re-pricing only happens when the line items change; otherwise we keep the
  // snapshot and just adjust the negotiated discount / metadata.
  if (input.items) {
    const ctx = await contextFor({
      customerId: existing.customerId,
      leadId: existing.leadId,
      staffStoreId: null,
    });
    const built = await buildItems(existing.storeId!, ctx.intra, input.items);
    const taxedTotal = built.subtotalPaise + built.cgstPaise + built.sgstPaise + built.igstPaise;
    const discountPaise = Math.min(discountInput, taxedTotal);

    return tenantTransaction(async (tx) => {
      await tx.quotationItem.deleteMany({ where: { quotationId: id } });
      return tx.quotation.update({
        where: { id },
        data: {
          title: input.title,
          notes: input.notes,
          validUntil,
          placeOfSupply: ctx.placeOfSupply,
          subtotalPaise: built.subtotalPaise,
          cgstPaise: built.cgstPaise,
          sgstPaise: built.sgstPaise,
          igstPaise: built.igstPaise,
          discountPaise,
          totalPaise: taxedTotal - discountPaise,
          items: { create: built.rows },
        },
        include: quotationInclude,
      });
    });
  }

  const taxedTotal =
    existing.subtotalPaise + existing.cgstPaise + existing.sgstPaise + existing.igstPaise;
  const discountPaise = Math.min(discountInput, taxedTotal);
  return prisma.quotation.update({
    where: { id },
    data: {
      title: input.title,
      notes: input.notes,
      validUntil,
      discountPaise,
      totalPaise: taxedTotal - discountPaise,
    },
    include: quotationInclude,
  });
}

export async function setStatus(id: string, status: QuotationStatus) {
  const existing = await prisma.quotation.findUnique({ where: { id } });
  if (!existing) throw ApiError.notFound('Quotation not found');
  if (existing.status === QuotationStatus.CONVERTED) {
    throw ApiError.badRequest('This quotation has been converted to an order');
  }
  if (status === QuotationStatus.CONVERTED) {
    throw ApiError.badRequest('Use convert to turn a quotation into an order');
  }
  return prisma.quotation.update({ where: { id }, data: { status }, include: quotationInclude });
}

/**
 * Turn an accepted quote into a real order, honouring the quoted unit prices
 * and lump-sum discount. Tax is recomputed against the chosen delivery address.
 * Restricted to Credit / Bank transfer — an online order can be paid afterwards
 * from the Orders screen (reissueRazorpay). Stock is consumed on creation.
 */
export async function convertQuotation(
  id: string,
  input: { paymentMethod: PaymentMethod; addressId?: string },
  staffSub: string,
) {
  const quote = await prisma.quotation.findUnique({ where: { id }, include: { items: true } });
  if (!quote) throw ApiError.notFound('Quotation not found');
  if (quote.status === QuotationStatus.CONVERTED || quote.orderId) {
    throw ApiError.badRequest('This quotation is already converted');
  }
  if (!quote.items.length) throw ApiError.badRequest('Quotation has no items');
  if (!quote.customerId) {
    throw ApiError.badRequest('Link this quotation to a customer before converting (convert the lead first).');
  }
  if (input.paymentMethod !== PaymentMethod.CREDIT && input.paymentMethod !== PaymentMethod.BANK_TRANSFER) {
    throw ApiError.badRequest(
      'Convert a quote on Credit or Bank transfer; online payment can be collected from the order afterwards.',
    );
  }

  const customer = await prisma.customer.findUnique({
    where: { id: quote.customerId },
    include: { store: true },
  });
  if (!customer) throw ApiError.notFound('Customer not found');
  if (!customer.storeId || !customer.store) {
    throw ApiError.badRequest('This customer is not linked to a store yet.');
  }
  const store = customer.store;

  const staffStoreId = await getStaffStoreId(staffSub);
  if (staffStoreId && staffStoreId !== store.id) {
    throw ApiError.forbidden('This customer belongs to another store');
  }

  let address;
  if (input.addressId) {
    address = await prisma.address.findUnique({ where: { id: input.addressId } });
    if (!address || address.customerId !== customer.id) {
      throw ApiError.badRequest('Delivery address not found');
    }
  } else {
    address = await prisma.address.findFirst({
      where: { customerId: customer.id },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
    });
    if (!address) throw ApiError.badRequest('This customer has no saved delivery address');
  }

  const intra = isIntraState(address.stateCode, address.state, store.stateCode, store.state);

  let subtotalPaise = 0;
  let cgstPaise = 0;
  let sgstPaise = 0;
  let igstPaise = 0;
  const orderItems = quote.items.map((it) => {
    const lineSubtotalPaise = it.unitPricePaise * it.quantity;
    const tax = computeLineTax(lineSubtotalPaise, it.gstRatePercent, intra);
    subtotalPaise += lineSubtotalPaise;
    cgstPaise += tax.cgstPaise;
    sgstPaise += tax.sgstPaise;
    igstPaise += tax.igstPaise;
    return {
      productId: it.productId,
      variantId: it.variantId,
      productName: it.productName,
      variantName: it.variantName,
      hsnCode: it.hsnCode,
      unit: it.unit,
      quantity: it.quantity,
      unitPricePaise: it.unitPricePaise,
      gstRatePercent: it.gstRatePercent,
      lineSubtotalPaise,
      cgstPaise: tax.cgstPaise,
      sgstPaise: tax.sgstPaise,
      igstPaise: tax.igstPaise,
      lineTotalPaise: lineSubtotalPaise + tax.taxPaise,
    };
  });
  const taxedTotal = subtotalPaise + cgstPaise + sgstPaise + igstPaise;
  const discountPaise = Math.min(quote.discountPaise, taxedTotal);
  const totalPaise = taxedTotal - discountPaise;

  if (input.paymentMethod === PaymentMethod.CREDIT) {
    if (!customer.creditApproved || customer.creditLimitPaise <= 0) {
      throw ApiError.badRequest('Credit is not approved for this customer');
    }
    const open = await prisma.order.aggregate({
      where: { customerId: customer.id, paymentMethod: PaymentMethod.CREDIT, paymentStatus: { not: 'PAID' } },
      _sum: { amountDuePaise: true },
    });
    const available = customer.creditLimitPaise - (open._sum.amountDuePaise ?? 0);
    if (totalPaise > available) {
      throw ApiError.badRequest(
        `Order exceeds the customer's available credit (₹${(available / 100).toFixed(0)} left)`,
      );
    }
  }

  const dueDate =
    input.paymentMethod === PaymentMethod.CREDIT && customer.creditDays > 0
      ? new Date(Date.now() + customer.creditDays * 24 * 60 * 60 * 1000)
      : null;

  return tenantTransaction(
    async (tx) => {
      const orderNumber = await nextOrderNumber(tx);
      const order = await tx.order.create({
        data: {
          orderNumber,
          customerId: customer.id,
          storeId: store.id,
          status: OrderStatus.PENDING,
          shipName: address.label ? `${customer.shopName} (${address.label})` : customer.shopName,
          shipLine1: address.line1,
          shipLine2: address.line2,
          shipCity: address.city,
          shipState: address.state,
          shipPincode: address.pincode,
          shipPhone: customer.phone,
          gstinUsed: customer.gstin,
          placeOfSupply: address.state,
          sellerStateCode: store.stateCode,
          subtotalPaise,
          discountPaise,
          deliveryPaise: 0,
          cgstPaise,
          sgstPaise,
          igstPaise,
          totalPaise,
          paymentMethod: input.paymentMethod,
          paymentStatus: OrderPaymentStatus.UNPAID,
          amountPaidPaise: 0,
          amountDuePaise: totalPaise,
          dueDate,
          items: { create: orderItems },
        },
        include: { items: true },
      });

      await recordOrderEvent(tx, order.id, OrderStatus.PENDING, {
        note: `Created from quotation ${quote.quoteNumber}`,
        userId: staffSub,
      });

      // Consume stock now (conditional decrement guards against overselling).
      for (const it of orderItems) {
        const dec = it.variantId
          ? await tx.storeVariant.updateMany({
              where: { storeId: store.id, variantId: it.variantId, stockQty: { gte: it.quantity } },
              data: { stockQty: { decrement: it.quantity } },
            })
          : await tx.storeProduct.updateMany({
              where: { storeId: store.id, productId: it.productId, stockQty: { gte: it.quantity } },
              data: { stockQty: { decrement: it.quantity } },
            });
        if (dec.count !== 1) throw ApiError.badRequest(`${it.productName} just went out of stock`);
        await recordStockMovement(tx, {
          storeId: store.id,
          productId: it.productId,
          variantId: it.variantId,
          deltaQty: -it.quantity,
          type: StockMovementType.SALE,
          orderId: order.id,
          userId: staffSub,
        });
      }

      if (input.paymentMethod === PaymentMethod.BANK_TRANSFER) {
        await tx.payment.create({
          data: {
            orderId: order.id,
            method: PaymentMethod.BANK_TRANSFER,
            amountPaise: totalPaise,
            status: PaymentStatus.CREATED,
            note: `From quotation ${quote.quoteNumber}`,
          },
        });
      }

      const quotation = await tx.quotation.update({
        where: { id },
        data: { status: QuotationStatus.CONVERTED, orderId: order.id, orderNumber: order.orderNumber },
        include: quotationInclude,
      });
      return { order, quotation };
    },
    { maxWait: 15000, timeout: 30000 },
  );
}
