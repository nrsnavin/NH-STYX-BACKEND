import { Request, Response } from 'express';
import { asyncHandler } from '../../utils/asyncHandler';
import * as cartService from './cart.service';

export const get = asyncHandler(async (req: Request, res: Response) => {
  const data = await cartService.getCart(req.auth!.sub);
  res.json({ success: true, data });
});

export const addItem = asyncHandler(async (req: Request, res: Response) => {
  const data = await cartService.addItem(
    req.auth!.sub,
    req.body.productId,
    req.body.quantity,
    req.body.variantId,
  );
  res.status(201).json({ success: true, data });
});

export const updateItem = asyncHandler(async (req: Request, res: Response) => {
  const data = await cartService.setItemQuantity(
    req.auth!.sub,
    req.params.productId,
    req.body.quantity,
    req.body.variantId,
  );
  res.json({ success: true, data });
});

export const removeItem = asyncHandler(async (req: Request, res: Response) => {
  const data = await cartService.removeItem(
    req.auth!.sub,
    req.params.productId,
    (req.query.variantId as string | undefined) ?? null,
  );
  res.json({ success: true, data });
});

export const clear = asyncHandler(async (req: Request, res: Response) => {
  const data = await cartService.clearCart(req.auth!.sub);
  res.json({ success: true, data });
});
