import { Response } from 'express';
import PDFDocument from 'pdfkit';
import { prisma } from '../../lib/prisma';
import { ApiError } from '../../utils/ApiError';
import { getStaffStoreId } from '../../utils/storeContext';

const rs = (paise: number) => `Rs. ${(paise / 100).toFixed(2)}`;
const ymd = (d: Date) => d.toISOString().slice(0, 10);

/** Streams a quotation PDF to the response (for staff or the owning customer). */
export async function streamQuotationPdf(
  quotationId: string,
  actor: { sub: string; type: 'STAFF' | 'CUSTOMER'; role?: string },
  res: Response,
) {
  const quote = await prisma.quotation.findUnique({
    where: { id: quotationId },
    include: {
      items: true,
      customer: { select: { shopName: true, phone: true, gstin: true } },
      lead: { select: { shopName: true, phone: true } },
      store: true,
    },
  });
  if (!quote) throw ApiError.notFound('Quotation not found');

  // Authorization: the owning customer, or staff scoped to the quote's store.
  if (actor.type === 'CUSTOMER' && quote.customerId !== actor.sub) {
    throw ApiError.forbidden('You cannot view this quotation');
  }
  if (actor.type === 'STAFF' && actor.role !== 'ADMIN') {
    const storeId = await getStaffStoreId(actor.sub);
    if (storeId && quote.storeId !== storeId) {
      throw ApiError.forbidden('This quotation belongs to another store');
    }
  }

  const recipientName = quote.customer?.shopName ?? quote.lead?.shopName ?? '—';
  const recipientPhone = quote.customer?.phone ?? quote.lead?.phone ?? '';
  const taxPaise = quote.cgstPaise + quote.sgstPaise + quote.igstPaise;
  const intra = quote.igstPaise === 0;

  const doc = new PDFDocument({ size: 'A4', margin: 50 });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${quote.quoteNumber}.pdf"`);
  doc.pipe(res);

  // Title
  doc.fontSize(18).font('Helvetica-Bold').text('QUOTATION', { align: 'center' });
  if (quote.title) doc.fontSize(10).font('Helvetica').text(quote.title, { align: 'center' });
  doc.moveDown(0.5);

  // Seller (store) + quote meta
  const top = doc.y;
  doc.fontSize(11).font('Helvetica-Bold').text(quote.store?.name ?? 'NH Styx', 50, top);
  doc.font('Helvetica').fontSize(9);
  if (quote.store?.addressLine) doc.text(quote.store.addressLine, 50);
  doc.text(`${quote.store?.city ?? ''}, ${quote.store?.state ?? ''} ${quote.store?.pincode ?? ''}`.trim(), 50);
  doc.text(`GST State Code: ${quote.sellerStateCode ?? quote.store?.stateCode ?? '-'}`, 50);
  if (quote.store?.phone) doc.text(`Phone: ${quote.store.phone}`, 50);

  doc.fontSize(9).font('Helvetica');
  doc.text(`Quote No: ${quote.quoteNumber}`, 330, top, { align: 'right' });
  doc.text(`Date: ${ymd(quote.createdAt)}`, 330, doc.y, { align: 'right' });
  if (quote.validUntil) doc.text(`Valid Until: ${ymd(quote.validUntil)}`, 330, doc.y, { align: 'right' });
  doc.text(`Status: ${quote.status}`, 330, doc.y, { align: 'right' });
  if (quote.placeOfSupply) doc.text(`Place of Supply: ${quote.placeOfSupply}`, 330, doc.y, { align: 'right' });

  doc.y = top + 95;

  // Recipient
  doc.fontSize(10).font('Helvetica-Bold').text('Quote For:', 50);
  doc.font('Helvetica').fontSize(9);
  doc.text(recipientName);
  if (recipientPhone) doc.text(`Phone: ${recipientPhone}`);
  if (quote.customer?.gstin) doc.text(`GSTIN: ${quote.customer.gstin}`);
  doc.moveDown(1);

  // Items table
  const cols = { item: 50, qty: 300, rate: 350, taxable: 410, gst: 470, total: 500 };
  const headerY = doc.y;
  doc.font('Helvetica-Bold').fontSize(8);
  doc.text('Item', cols.item, headerY);
  doc.text('Qty', cols.qty, headerY);
  doc.text('Rate', cols.rate, headerY);
  doc.text('Taxable', cols.taxable, headerY);
  doc.text('GST%', cols.gst, headerY);
  doc.text('Total', cols.total, headerY);
  doc.moveTo(50, doc.y + 2).lineTo(545, doc.y + 2).stroke();
  doc.moveDown(0.5);

  doc.font('Helvetica').fontSize(8);
  for (const it of quote.items) {
    const y = doc.y;
    doc.text(it.variantName ? `${it.productName} (${it.variantName})` : it.productName, cols.item, y, {
      width: 245,
    });
    const lineY = Math.max(y, doc.y);
    doc.text(String(it.quantity), cols.qty, y);
    doc.text(rs(it.unitPricePaise), cols.rate, y, { width: 55 });
    doc.text(rs(it.lineSubtotalPaise), cols.taxable, y, { width: 55 });
    doc.text(`${it.gstRatePercent}%`, cols.gst, y);
    doc.text(rs(it.lineTotalPaise), cols.total, y, { width: 45 });
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
  label('Subtotal', rs(quote.subtotalPaise));
  if (taxPaise > 0) {
    if (intra) {
      label('CGST', rs(quote.cgstPaise));
      label('SGST', rs(quote.sgstPaise));
    } else {
      label('IGST', rs(quote.igstPaise));
    }
  }
  if (quote.discountPaise > 0) label('Discount', `- ${rs(quote.discountPaise)}`);
  doc.moveDown(0.2);
  label('Total', rs(quote.totalPaise), true);

  // Notes
  if (quote.notes) {
    doc.moveDown(1.5);
    doc.font('Helvetica-Bold').fontSize(9).text('Notes / Terms', 50, doc.y);
    doc.font('Helvetica').fontSize(8).fillColor('#333').text(quote.notes, 50, doc.y, { width: 495 });
    doc.fillColor('#000');
  }

  doc.moveDown(2);
  doc.font('Helvetica').fontSize(8).fillColor('#666')
    .text('This is a quotation, not a tax invoice. Prices are subject to the validity above.', 50, doc.y, {
      align: 'center',
    });

  doc.end();
}
