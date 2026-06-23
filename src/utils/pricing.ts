import { env } from '../config/env';

/**
 * All money is integer paise. These helpers centralize wholesale price-tier
 * resolution and GST computation so checkout and previews stay consistent.
 */

export interface TierLike {
  minQty: number;
  pricePaise: number;
}

/**
 * Resolve the per-unit price for a quantity: the tier with the highest
 * `minQty` that is <= quantity wins; otherwise the product base price.
 */
export function resolveUnitPrice(
  basePricePaise: number,
  tiers: TierLike[],
  quantity: number,
): number {
  let price = basePricePaise;
  let bestMinQty = 0;
  for (const tier of tiers) {
    if (quantity >= tier.minQty && tier.minQty >= bestMinQty) {
      price = tier.pricePaise;
      bestMinQty = tier.minQty;
    }
  }
  return price;
}

export interface LineTax {
  cgstPaise: number;
  sgstPaise: number;
  igstPaise: number;
  taxPaise: number;
}

/**
 * Split GST for a line. Intra-state -> CGST + SGST (half each); inter-state -> IGST.
 */
export function computeLineTax(
  lineSubtotalPaise: number,
  gstRatePercent: number,
  intraState: boolean,
): LineTax {
  if (gstRatePercent <= 0) {
    return { cgstPaise: 0, sgstPaise: 0, igstPaise: 0, taxPaise: 0 };
  }
  if (intraState) {
    const half = Math.round((lineSubtotalPaise * gstRatePercent) / 200);
    return { cgstPaise: half, sgstPaise: half, igstPaise: 0, taxPaise: half * 2 };
  }
  const igst = Math.round((lineSubtotalPaise * gstRatePercent) / 100);
  return { cgstPaise: 0, sgstPaise: 0, igstPaise: igst, taxPaise: igst };
}

/**
 * Whether a buyer's state matches the seller's state (intra-state supply).
 * Prefers the 2-digit GST state code; falls back to state-name comparison.
 *
 * The seller side defaults to the platform's configured state, but a per-store
 * state can be passed so tax is computed from the *fulfilling store's* origin —
 * this is what makes multi-state correct without touching call sites that don't
 * yet pass a store.
 */
export function isIntraState(
  buyerStateCode?: string | null,
  buyerStateName?: string | null,
  sellerStateCode: string = env.SELLER_STATE_CODE,
  sellerStateName: string = env.SELLER_STATE_NAME,
): boolean {
  if (buyerStateCode && buyerStateCode.trim()) {
    return buyerStateCode.trim() === sellerStateCode;
  }
  if (buyerStateName) {
    return buyerStateName.trim().toLowerCase() === sellerStateName.toLowerCase();
  }
  return false;
}

/** Convenience for logs/tests. Not used for storage. */
export const paiseToRupees = (paise: number): number => paise / 100;
