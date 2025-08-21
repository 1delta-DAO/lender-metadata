import { z } from 'zod';
// Example upstream shape (adjust to your source)
export const UpstreamSchema = z.object({
    items: z.array(z.object({
        id: z.union([z.string(), z.number()]),
        name: z.string(),
        category: z.string().nullable().optional()
    }))
});
// Public, stable shape your frontend consumes
export const DisplayItemSchema = z.object({
    id: z.string(),
    label: z.string(),
    group: z.string().nullable().optional()
});
export const DisplayDataSchema = z.object({
    items: z.array(DisplayItemSchema)
});
