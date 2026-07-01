import { Response } from 'express';
import PDFDocument from 'pdfkit';
import { prisma } from '../../lib/prisma';
import { ApiError } from '../../utils/ApiError';
import { getStaffStoreId } from '../../utils/storeContext';
import { getSettings } from '../settings/settings.service';

const rs = (paise: number) => `Rs. ${(paise / 100).toFixed(2)}`;

/** Streams a GST tax invoice PDF for an order to the response. */
export async function streamInvoice(
  orderId: string,
  actor: { sub: string; type: 'STAFF' | 'CUSTOMER'; role?: string },
  res: Response,
) {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { items: true, customer: true, store: true },
  });
  if (!order) throw ApiError.notFound('Order not found');

  // Authorization: the owning customer, or staff scoped to the order's store.
  if (actor.type === 'CUSTOMER' && order.customerId !== actor.sub) {
    throw ApiError.forbidden('You cannot view this invoice');
  }
  if (actor.type === 'STAFF' && actor.role !== 'ADMIN') {
    const storeId = await getStaffStoreId(actor.sub);
    if (storeId && order.storeId !== storeId) {
      throw ApiError.forbidden('This order belongs to another store');
    }
  }

  const settings = await getSettings();
  const intra = order.igstPaise === 0;
  const doc = new PDFDocument({ size: 'A4', margin: 50 });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${order.orderNumber}.pdf"`);
  doc.pipe(res);

  // Title
  doc.fontSize(18).font('Helvetica-Bold').text('TAX INVOICE', { align: 'center' });
  doc.moveDown(0.5);

  // Seller (store) + invoice meta
  const top = doc.y;
  doc.fontSize(11).font('Helvetica-Bold').text(order.store?.name ?? (settings.businessName || 'NH Styx'), 50, top);
  doc.font('Helvetica').fontSize(9);
  if (order.store?.addressLine) doc.text(order.store.addressLine, 50);
  doc.text(`${order.store?.city ?? ''}, ${order.store?.state ?? ''} ${order.store?.pincode ?? ''}`.trim(), 50);
  doc.text(`GST State Code: ${order.sellerStateCode ?? order.store?.stateCode ?? '-'}`, 50);
  if (settings.gstin) doc.text(`GSTIN: ${settings.gstin}`, 50);
  if (order.store?.phone) doc.text(`Phone: ${order.store.phone}`, 50);
  else if (settings.supportPhone) doc.text(`Phone: ${settings.supportPhone}`, 50);

  doc.fontSize(9).font('Helvetica');
  doc.text(`Invoice No: ${order.orderNumber}`, 330, top, { align: 'right' });
  doc.text(`Date: ${order.createdAt.toISOString().slice(0, 10)}`, 330, doc.y, { align: 'right' });
  doc.text(`Place of Supply: ${order.placeOfSupply}`, 330, doc.y, { align: 'right' });

  // Drop below both the seller and meta blocks before the buyer section.
  doc.y = top + 95;

  // Buyer
  doc.fontSize(10).font('Helvetica-Bold').text('Bill / Ship To:', 50);
  doc.font('Helvetica').fontSize(9);
  doc.text(order.shipName);
  doc.text(`${order.shipLine1}${order.shipLine2 ? ', ' + order.shipLine2 : ''}`);
  doc.text(`${order.shipCity}, ${order.shipState} - ${order.shipPincode}`);
  doc.text(`Phone: ${order.shipPhone}`);
  if (order.gstinUsed) doc.text(`GSTIN: ${order.gstinUsed}`);
  doc.moveDown(1);

  // Items table
  const cols = { item: 50, hsn: 240, qty: 285, rate: 320, taxable: 385, gst: 450, total: 492 };
  const headerY = doc.y;
  doc.font('Helvetica-Bold').fontSize(8);
  doc.text('Item', cols.item, headerY);
  doc.text('HSN', cols.hsn, headerY);
  doc.text('Qty', cols.qty, headerY);
  doc.text('Rate', cols.rate, headerY);
  doc.text('Taxable', cols.taxable, headerY);
  doc.text('GST%', cols.gst, headerY);
  doc.text('Total', cols.total, headerY);
  doc.moveTo(50, doc.y + 2).lineTo(545, doc.y + 2).stroke();
  doc.moveDown(0.5);

  doc.font('Helvetica').fontSize(8);
  for (const it of order.items) {
    const y = doc.y;
    doc.text(it.variantName ? `${it.productName} (${it.variantName})` : it.productName, cols.item, y, {
      width: 195,
    });
    const lineY = Math.max(y, doc.y);
    doc.text(it.hsnCode ?? '-', cols.hsn, y);
    doc.text(String(it.quantity), cols.qty, y);
    doc.text(rs(it.unitPricePaise), cols.rate, y, { width: 60 });
    doc.text(rs(it.lineSubtotalPaise), cols.taxable, y, { width: 60 });
    doc.text(`${it.gstRatePercent}%`, cols.gst, y);
    doc.text(rs(it.lineTotalPaise), cols.total, y, { width: 53 });
    doc.y = lineY;
    doc.moveDown(0.4);
  }
  doc.moveTo(50, doc.y).lineTo(545, doc.y).stroke();
  doc.moveDown(0.5);

  // Totals
  const label = (t: string, v: string, bold = false) => {
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(9);
    doc.text(t, 360, doc.y, { width: 110, continued: true });
    doc.text(v, { align: 'right' });
  };
  label('Subtotal', rs(order.subtotalPaise));
  if (intra) {
    label('CGST', rs(order.cgstPaise));
    label('SGST', rs(order.sgstPaise));
  } else {
    label('IGST', rs(order.igstPaise));
  }
  if (order.deliveryPaise > 0) label('Delivery', rs(order.deliveryPaise));
  if (order.discountPaise > 0) {
    label(order.couponCode ? `Discount (${order.couponCode})` : 'Discount', `- ${rs(order.discountPaise)}`);
  }
  doc.moveDown(0.2);
  label('Grand Total', rs(order.totalPaise), true);

  doc.moveDown(1.5);
  doc.fillColor('#000').fontSize(8);
  const bankBits = [
    settings.bankName && `Bank: ${settings.bankName}`,
    settings.bankAccount && `A/c: ${settings.bankAccount}`,
    settings.bankIfsc && `IFSC: ${settings.bankIfsc}`,
    settings.bankUpi && `UPI: ${settings.bankUpi}`,
  ].filter(Boolean) as string[];
  if (bankBits.length) {
    doc.font('Helvetica-Bold').text('Payment details', 50);
    doc.font('Helvetica').text(bankBits.join('    '), 50, doc.y, { width: 495 });
    doc.moveDown(0.5);
  }
  if (settings.invoiceTerms) {
    doc.font('Helvetica-Bold').text('Terms & conditions', 50);
    doc.font('Helvetica').text(settings.invoiceTerms, 50, doc.y, { width: 495 });
    doc.moveDown(0.5);
  }

  doc.moveDown(1);
  doc.font('Helvetica').fontSize(8).fillColor('#666');
  if (settings.invoiceFooter) {
    doc.text(settings.invoiceFooter, 50, doc.y, { align: 'center', width: 495 });
  }
  doc.text('This is a computer-generated invoice.', 50, doc.y, { align: 'center', width: 495 });

  doc.end();
}
