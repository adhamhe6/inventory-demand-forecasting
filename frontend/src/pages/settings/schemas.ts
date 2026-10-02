import { z } from 'zod'
import type { Role } from '@/lib/types'
import { ROLES } from './roles'

const password = z
  .string()
  .min(10, 'At least 10 characters')
  .max(256, 'At most 256 characters')
  .refine((v) => /[A-Za-z]/.test(v) && /\d/.test(v), 'Must contain both letters and digits')

const roleEnum = z.enum(ROLES as [Role, ...Role[]])

export const createSchema = z.object({
  email: z.string().trim().min(1, 'Email is required').email('Enter a valid email address'),
  full_name: z.string().trim().min(1, 'Name is required').max(200),
  role: roleEnum,
  password,
})

export const editSchema = z.object({
  full_name: z.string().trim().min(1, 'Name is required').max(200),
  role: roleEnum,
  is_active: z.boolean(),
  password: z.union([z.literal(''), password]),
})

export type CreateValues = z.infer<typeof createSchema>
export type EditValues = z.infer<typeof editSchema>
