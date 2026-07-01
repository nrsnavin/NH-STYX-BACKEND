import { prisma } from '../../lib/prisma';

// ---- CSV helpers ------------------------------------------------------------

function cell(v: unknown): string {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(headers: string[], rows: unknown[][]): string {
  return [headers, ...rows].map((r) => r.map(cell).join(',')).join('\n');
}

/** Paise → rupees as a plain 2-dp number for spreadsheets. */
const rupees = (paise: number) => (paise / 100).toFixed(2);

interface Range {
  from?: Date;
  to?: Date;
}
function range(r: Range) {
  return { gte: r.from ?? new Date(0), lte: r.to ?? new Date() };
}

// ---- Reports ----------------------------------------------------------------

/** Sales register: one row per order over the period. */
export async function salesRegisterCsv(storeId: string | null, r: Range): Promise<string> {
  const orders = await prisma.order.findMany({
    where: {
      ...(storeId ? { storeId } : {}),
      createdAt: range(r),
      status: { not: 'CANCELLED' },
    },
    include: {
      customer: { select: { shopName: true, gstin: true, phone: true } },
      store: { select: { name: true } },
    },
    orderBy: { createdAt: 'asc' },
  });
  return toCsv(
    [
      'Date',
      'Order #',
      'Invoice #',
      'Shop',
      'GSTIN',
      'Phone',
      'Store',
      'Payment method',
      'Payment status',
      'Status',
      'Subtotal',
      'Discount',
      'CGST',
      'SGST',
      'IGST',
      'Total',
    ],
    orders.map((o) => [
      o.createdAt.toISOString().slice(0, 10),
      o.orderNumber,
      o.invoiceNumber ?? '',
      o.customer?.shopName ?? '',
      o.customer?.gstin ?? '',
      o.customer?.phone ?? '',
      o.store?.name ?? '',
      o.paymentMethod,
      o.paymentStatus,
      o.status,
      rupees(o.subtotalPaise),
      rupees(o.discountPaise),
      rupees(o.cgstPaise),
      rupees(o.sgstPaise),
      rupees(o.igstPaise),
      rupees(o.totalPaise),
    ]),
  );
}

/** GSTR-1-style tax summary: per invoice, taxable value + tax split. */
export async function gstSummaryCsv(storeId: string | null, r: Range): Promise<string> {
  const orders = await prisma.order.findMany({
    where: {
      ...(storeId ? { storeId } : {}),
      createdAt: range(r),
      status: { not: 'CANCELLED' },
    },
    include: { customer: { select: { shopName: true, gstin: true } } },
    orderBy: { createdAt: 'asc' },
  });
  return toCsv(
    [
      'Invoice #',
      'Order #',
      'Date',
      'GSTIN',
      'Shop',
      'Place of supply',
      'Taxable value',
      'CGST',
      'SGST',
      'IGST',
      'Invoice value',
    ],
    orders.map((o) => [
      o.invoiceNumber ?? '',
      o.orderNumber,
      o.createdAt.toISOString().slice(0, 10),
      o.customer?.gstin ?? '',
      o.customer?.shopName ?? '',
      o.placeOfSupply,
      rupees(o.subtotalPaise - o.discountPaise),
      rupees(o.cgstPaise),
      rupees(o.sgstPaise),
      rupees(o.igstPaise),
      rupees(o.totalPaise),
    ]),
  );
}

/** Inventory valuation: stock on hand × unit price, per store product. */
export async function inventoryValuationCsv(storeId: string | null): Promise<string> {
  const rows = await prisma.storeProduct.findMany({
    where: { isActive: true, ...(storeId ? { storeId } : {}) },
    include: {
      product: { select: { name: true, unit: true, hsnCode: true } },
      store: { select: { name: true, city: true } },
    },
    orderBy: [{ store: { name: 'asc' } }, { product: { name: 'asc' } }],
  });
  return toCsv(
    ['Store', 'City', 'Product', 'HSN', 'Unit', 'Stock qty', 'Unit price', 'Stock value'],
    rows.map((sp) => [
      sp.store.name,
      sp.store.city,
      sp.product.name,
      sp.product.hsnCode ?? '',
      sp.product.unit,
      sp.stockQty,
      rupees(sp.pricePaise),
      rupees(sp.stockQty * sp.pricePaise),
    ]),
  );
}
