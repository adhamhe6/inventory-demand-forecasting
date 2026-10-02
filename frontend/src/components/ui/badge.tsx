import { cva, type VariantProps } from 'class-variance-authority'
import type * as React from 'react'
import { cn } from '@/lib/utils'

export const badgeVariants = cva(
  'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap [&_svg]:size-3',
  {
    variants: {
      variant: {
        default: 'border-transparent bg-primary/10 text-primary',
        secondary: 'border-transparent bg-secondary text-secondary-foreground',
        outline: 'text-foreground',
        success: 'border-transparent bg-emerald-500/12 text-emerald-700 dark:text-emerald-400',
        warning: 'border-transparent bg-amber-500/15 text-amber-700 dark:text-amber-400',
        orange: 'border-transparent bg-orange-500/15 text-orange-700 dark:text-orange-400',
        danger: 'border-transparent bg-red-500/12 text-red-700 dark:text-red-400',
        info: 'border-transparent bg-sky-500/12 text-sky-700 dark:text-sky-400',
        muted: 'border-transparent bg-muted text-muted-foreground',
      },
    },
    defaultVariants: { variant: 'default' },
  },
)

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />
}
