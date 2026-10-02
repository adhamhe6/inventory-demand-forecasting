import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { toast } from 'sonner'
import { STOCK_KEYS } from '@/api/queries'
import { InlineError } from '@/components/common/States'
import { ConfirmDialog } from '@/components/ui/alert-dialog'
import { ApiError, api, errorMessage } from '@/lib/api'
import type { Product } from '@/lib/types'

type Pending = { kind: 'delete'; product: Product } | { kind: 'in-use'; product: Product; message: string } | { kind: 'deactivate'; product: Product }

/**
 * Delete / deactivate / reactivate flows for a product, with confirmations.
 * A product with stock, sales or PO history can't be deleted (409 PRODUCT_IN_USE): we then
 * offer to deactivate it instead, which hides it from ordering but keeps the audit trail.
 */
export function useProductLifecycle({ onDeleted }: { onDeleted?: (p: Product) => void } = {}) {
  const qc = useQueryClient()
  const [pending, setPending] = useState<Pending | null>(null)

  const invalidate = () => STOCK_KEYS.forEach((key) => qc.invalidateQueries({ queryKey: key }))

  const del = useMutation({
    mutationFn: (p: Product) => api.delete(`/products/${p.id}`),
    onSuccess: (_r, p) => {
      invalidate()
      toast.success('Product deleted', { description: `${p.sku} — ${p.name}` })
      setPending(null)
      onDeleted?.(p)
    },
    onError: (e, p) => {
      if (e instanceof ApiError && e.status === 409 && e.code === 'PRODUCT_IN_USE') {
        del.reset()
        if (p.is_active) setPending({ kind: 'in-use', product: p, message: e.message })
        else {
          // Already inactive: nothing more to offer – explain and close.
          setPending(null)
          toast.error('This product can’t be deleted', { description: 'It has stock, sales or purchase history. It is already inactive, so nothing else is needed.' })
        }
      }
    },
  })

  const setActive = useMutation({
    mutationFn: ({ product, active }: { product: Product; active: boolean }) => api.patch<Product>(`/products/${product.id}`, { is_active: active }),
    onSuccess: (p, { active }) => {
      invalidate()
      toast.success(active ? 'Product reactivated' : 'Product deactivated', { description: `${p.sku} — ${p.name}` })
      setPending(null)
    },
    onError: (e, { active }) => {
      if (active) toast.error('Could not reactivate product', { description: errorMessage(e) })
    },
  })

  const close = (open: boolean) => {
    if (open || del.isPending || setActive.isPending) return
    setPending(null)
    del.reset()
    setActive.reset()
  }

  const dialogs = (
    <>
      <ConfirmDialog
        open={pending?.kind === 'delete'}
        onOpenChange={close}
        title="Delete product?"
        destructive
        confirmLabel="Delete product"
        loading={del.isPending}
        onConfirm={() => pending && del.mutate(pending.product)}
        description={
          pending && (
            <p>
              <span className="font-mono font-medium text-foreground">{pending.product.sku}</span> — {pending.product.name} will be permanently removed. This
              only works for products without stock, sales or purchase history.
            </p>
          )
        }
      >
        {del.error && <InlineError error={del.error} />}
      </ConfirmDialog>

      <ConfirmDialog
        open={pending?.kind === 'in-use' || pending?.kind === 'deactivate'}
        onOpenChange={close}
        title={pending?.kind === 'in-use' ? 'This product can’t be deleted' : 'Deactivate product?'}
        confirmLabel={pending?.kind === 'in-use' ? 'Deactivate instead' : 'Deactivate'}
        loading={setActive.isPending}
        onConfirm={() => pending && setActive.mutate({ product: pending.product, active: false })}
        description={
          pending && (
            <div className="grid gap-2">
              {pending.kind === 'in-use' && <p className="font-medium text-foreground">{pending.message}.</p>}
              <p>
                Deactivating <span className="font-mono font-medium text-foreground">{pending.product.sku}</span> hides it from purchase orders and stock
                operations. Its stock, sales and movement history are kept, and you can reactivate it at any time.
              </p>
            </div>
          )
        }
      >
        {setActive.error && <InlineError error={setActive.error} />}
      </ConfirmDialog>
    </>
  )

  return {
    requestDelete: (product: Product) => setPending({ kind: 'delete', product }),
    requestDeactivate: (product: Product) => setPending({ kind: 'deactivate', product }),
    reactivate: (product: Product) => setActive.mutate({ product, active: true }),
    reactivating: setActive.isPending && !pending,
    dialogs,
  }
}
