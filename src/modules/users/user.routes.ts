import { Request, Response, Router } from 'express';
import { z } from 'zod';
import { Role } from '@prisma/client';
import { authenticate, authorize } from '../../middlewares/auth.middleware';
import { validate } from '../../middlewares/validate.middleware';
import { asyncHandler } from '../../utils/asyncHandler';
import * as userService from './user.service';

const listSchema = z.object({
  query: z.object({ search: z.string().optional(), role: z.nativeEnum(Role).optional() }),
});
const createSchema = z.object({
  body: z.object({
    name: z.string().min(2),
    email: z.string().email(),
    password: z.string().min(8),
    role: z.nativeEnum(Role).default(Role.AGENT),
    phone: z.string().optional(),
    storeId: z.string().uuid().nullable().optional(),
  }),
});
const updateSchema = z.object({
  params: z.object({ id: z.string().uuid() }),
  body: z.object({
    name: z.string().min(2).optional(),
    phone: z.string().nullable().optional(),
    role: z.nativeEnum(Role).optional(),
    storeId: z.string().uuid().nullable().optional(),
    isActive: z.boolean().optional(),
    password: z.string().min(8).optional(),
  }),
});

const router = Router();
const admin = [authenticate, authorize('ADMIN')] as const;

router.get(
  '/',
  ...admin,
  validate(listSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const items = await userService.listUsers(req.query as { search?: string; role?: Role });
    res.json({ success: true, items });
  }),
);
router.post(
  '/',
  ...admin,
  validate(createSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const data = await userService.createUser(req.body);
    res.status(201).json({ success: true, data });
  }),
);
router.patch(
  '/:id',
  ...admin,
  validate(updateSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const data = await userService.updateUser(req.params.id, req.body);
    res.json({ success: true, data });
  }),
);

export default router;
