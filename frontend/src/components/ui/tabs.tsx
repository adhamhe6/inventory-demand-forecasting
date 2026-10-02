import * as TabsPrimitive from '@radix-ui/react-tabs'
import * as React from 'react'
import { cn } from '@/lib/utils'

export const Tabs = TabsPrimitive.Root

export const TabsList = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.List>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.List>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.List
    ref={ref}
    className={cn('inline-flex h-9 max-w-full items-center overflow-x-auto rounded-lg bg-muted p-1 text-muted-foreground', className)}
    {...props}
  />
))
TabsList.displayName = 'TabsList'

export const TabsTrigger = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>
>(({ className, ...props }, ref) => {
  const inner = React.useRef<HTMLButtonElement | null>(null)
  React.useImperativeHandle(ref, () => inner.current as HTMLButtonElement)
  // On narrow screens the list scrolls horizontally; keep the active tab visible (e.g. after a
  // deep link to ?tab=…). Only the list scrolls, never the page.
  React.useLayoutEffect(() => {
    const el = inner.current
    const list = el?.parentElement
    if (!el || !list || el.dataset.state !== 'active' || list.scrollWidth <= list.clientWidth) return
    const left = el.getBoundingClientRect().left - list.getBoundingClientRect().left + list.scrollLeft
    if (left < list.scrollLeft || left + el.offsetWidth > list.scrollLeft + list.clientWidth) {
      list.scrollLeft = Math.max(0, left - (list.clientWidth - el.offsetWidth) / 2)
    }
  })
  return (
    <TabsPrimitive.Trigger
      ref={inner}
      className={cn(
        'inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md px-3 py-1 text-sm font-medium transition-all cursor-pointer data-[state=active]:bg-card data-[state=active]:text-foreground data-[state=active]:shadow-sm [&_svg]:size-4',
        className,
      )}
      {...props}
    />
  )
})
TabsTrigger.displayName = 'TabsTrigger'

export const TabsContent = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Content>
>(({ className, ...props }, ref) => <TabsPrimitive.Content ref={ref} className={cn('mt-4', className)} {...props} />)
TabsContent.displayName = 'TabsContent'
