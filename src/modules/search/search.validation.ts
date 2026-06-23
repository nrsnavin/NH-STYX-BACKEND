import { z } from 'zod';

export const aiSearchSchema = z.object({
  body: z.object({
    query: z.string().min(1).max(300),
  }),
});
