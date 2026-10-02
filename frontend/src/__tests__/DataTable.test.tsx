import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { type Column, DataTable } from '@/components/common/DataTable'

type Row = { id: number; name: string }
const columns: Column<Row>[] = [
  { key: 'name', header: 'Name', sortKey: 'name', cell: (r) => r.name },
  { key: 'id', header: 'ID', cell: (r) => r.id },
]

describe('DataTable', () => {
  it('renders rows and toggles sort direction', () => {
    const onSort = vi.fn()
    const { rerender } = render(
      <DataTable columns={columns} rows={[{ id: 1, name: 'Alpha' }]} rowKey={(r) => r.id} sort="name" onSortChange={onSort} />,
    )
    expect(screen.getByText('Alpha')).toBeInTheDocument()
    expect(screen.getByRole('columnheader', { name: /Name/ })).toHaveAttribute('aria-sort', 'ascending')
    fireEvent.click(screen.getByRole('button', { name: /Name/ }))
    expect(onSort).toHaveBeenCalledWith('-name')
    rerender(<DataTable columns={columns} rows={[{ id: 1, name: 'Alpha' }]} rowKey={(r) => r.id} sort="-name" onSortChange={onSort} />)
    fireEvent.click(screen.getByRole('button', { name: /Name/ }))
    expect(onSort).toHaveBeenLastCalledWith('name')
  })

  it('shows empty, loading and error states', () => {
    const { rerender } = render(<DataTable columns={columns} rows={[]} rowKey={(r) => r.id} />)
    expect(screen.getByText('No results')).toBeInTheDocument()
    rerender(<DataTable columns={columns} rows={undefined} loading rowKey={(r) => r.id} />)
    expect(screen.getByLabelText('Loading')).toBeInTheDocument()
    const retry = vi.fn()
    rerender(<DataTable columns={columns} rows={undefined} error={new Error('boom')} onRetry={retry} rowKey={(r) => r.id} />)
    fireEvent.click(screen.getByRole('button', { name: /Try again/ }))
    expect(retry).toHaveBeenCalled()
  })

  it('paginates', () => {
    const onPage = vi.fn()
    render(
      <DataTable columns={columns} rows={[{ id: 1, name: 'A' }]} rowKey={(r) => r.id} page={1} pageSize={10} total={35} onPageChange={onPage} />,
    )
    expect(screen.getByText('1 / 4')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Previous page' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }))
    expect(onPage).toHaveBeenCalledWith(2)
  })
})
