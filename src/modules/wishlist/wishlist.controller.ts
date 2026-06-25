import { Request, Response } from 'express';
import { asyncHandler } from '../../utils/asyncHandler';
import * as wishlistService from './wishlist.service';

/** Full product cards for the wishlist screen. */
export const list = asyncHandler(async (req: Request, res: Response) => {
  const items = await wishlistService.listWishlist(req.auth!.sub);
  res.json({ success: true, items });
});

/** Just the wishlisted product ids — powers the heart toggle across the app. */
export const ids = asyncHandler(async (req: Request, res: Response) => {
  const data = await wishlistService.wishlistProductIds(req.auth!.sub);
  res.json({ success: true, data });
});

export const add = asyncHandler(async (req: Request, res: Response) => {
  await wishlistService.addToWishlist(req.auth!.sub, req.params.productId);
  res.status(201).json({ success: true, message: 'Saved to wishlist' });
});

export const remove = asyncHandler(async (req: Request, res: Response) => {
  await wishlistService.removeFromWishlist(req.auth!.sub, req.params.productId);
  res.json({ success: true, message: 'Removed from wishlist' });
});
