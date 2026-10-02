import { useQuery } from '@tanstack/react-query'
import { Bell, ChevronRight, LogOut, Menu, Moon, PackageSearch, Settings as SettingsIcon, Sun, X } from 'lucide-react'
import { type ReactNode, useEffect, useState } from 'react'
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
import { qk } from '@/api/queries'
import { RiskBadge } from '@/components/common/StatusBadge'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { api } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { useTheme } from '@/lib/theme'
import type { StockRisk } from '@/lib/types'
import { cn, fmt } from '@/lib/utils'
import { ALL_NAV, NAV_SECTIONS } from './nav'

function SidebarNav({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <nav aria-label="Main" className="flex-1 space-y-6 overflow-y-auto px-3 py-4">
      {NAV_SECTIONS.map((section) => (
        <div key={section.title}>
          <p className="mb-2 px-3 text-[11px] font-semibold uppercase tracking-wider text-sidebar-foreground/50">{section.title}</p>
          <ul className="space-y-0.5">
            {section.items.map((item) => (
              <li key={item.to}>
                <NavLink
                  to={item.to}
                  end={item.to === '/'}
                  onClick={onNavigate}
                  className={({ isActive }) =>
                    cn(
                      'flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium text-sidebar-foreground/80 transition-colors hover:bg-sidebar-accent hover:text-white',
                      isActive && 'bg-sidebar-accent text-white shadow-sm',
                    )
                  }
                >
                  <item.icon className="size-4 shrink-0" aria-hidden />
                  {item.label}
                </NavLink>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </nav>
  )
}

function Brand() {
  return (
    <Link to="/" className="flex items-center gap-2.5 px-6 py-5 text-white">
      <span className="flex size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground shadow">
        <PackageSearch className="size-4.5" aria-hidden />
      </span>
      <span className="leading-tight">
        <span className="block text-[15px] font-semibold tracking-tight">StockSense</span>
        <span className="block text-[11px] text-sidebar-foreground/60">Inventory & Forecasting</span>
      </span>
    </Link>
  )
}

function Breadcrumbs() {
  const { pathname } = useLocation()
  const parts = pathname.split('/').filter(Boolean)
  const root = ALL_NAV.find((n) => n.to === `/${parts[0] ?? ''}`) ?? ALL_NAV[0]
  return (
    <nav aria-label="Breadcrumb" className="hidden min-w-0 items-center gap-1.5 text-sm text-muted-foreground md:flex">
      <Link to="/" className="hover:text-foreground">
        Home
      </Link>
      {parts.length > 0 && (
        <>
          <ChevronRight className="size-3.5" aria-hidden />
          <Link to={root.to} className={cn('hover:text-foreground', parts.length === 1 && 'font-medium text-foreground')}>
            {root.label}
          </Link>
        </>
      )}
      {parts.length > 1 && (
        <>
          <ChevronRight className="size-3.5" aria-hidden />
          <span className="truncate font-medium text-foreground">{decodeURIComponent(parts[1]) === 'new' ? 'New' : 'Details'}</span>
        </>
      )}
    </nav>
  )
}

function Notifications() {
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const { data } = useQuery({
    queryKey: qk.shortages({ min_risk: 'HIGH' }),
    queryFn: () => api.get<StockRisk[]>('/shortages', { min_risk: 'HIGH' }),
    refetchInterval: 120_000,
  })
  const count = data?.length ?? 0
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon" aria-label={`Notifications${count ? ` (${count} stock alerts)` : ''}`} className="relative">
          <Bell />
          {count > 0 && (
            <span className="absolute right-1 top-1 flex min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-semibold leading-4 text-white">
              {count > 99 ? '99+' : count}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-96">
        <div className="flex items-center justify-between border-b px-4 py-3">
          <p className="text-sm font-semibold">Stock alerts</p>
          <span className="text-xs text-muted-foreground">High & critical risks</span>
        </div>
        <ul className="max-h-80 overflow-y-auto">
          {count === 0 && <li className="px-4 py-8 text-center text-sm text-muted-foreground">No high-risk items. 🎉</li>}
          {data?.slice(0, 8).map((r) => (
            <li key={r.inventory_item_id}>
              <button
                type="button"
                className="flex w-full items-start gap-3 px-4 py-3 text-left hover:bg-muted/60"
                onClick={() => {
                  setOpen(false)
                  navigate(`/products/${r.product_id}`)
                }}
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{r.product_name}</p>
                  <p className="text-xs text-muted-foreground">
                    {r.warehouse_code} · {fmt.int(r.available_quantity)} available ·{' '}
                    {r.days_of_cover != null ? `${r.days_of_cover}d cover` : 'no demand'}
                  </p>
                </div>
                <RiskBadge level={r.risk_level} />
              </button>
            </li>
          ))}
        </ul>
        <div className="border-t p-2">
          <Button
            variant="ghost"
            size="sm"
            className="w-full"
            onClick={() => {
              setOpen(false)
              navigate('/stock-risks')
            }}
          >
            View all stock risks
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}

function UserMenu() {
  const { user, logout } = useAuth()
  const navigate = useNavigate()
  if (!user) return null
  const initials = user.full_name
    .split(' ')
    .map((p) => p[0])
    .slice(0, 2)
    .join('')
    .toUpperCase()
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="flex items-center gap-2 rounded-full p-0.5 pr-2 transition hover:bg-muted"
          aria-label="Open user menu"
        >
          <span className="flex size-8 items-center justify-center rounded-full bg-primary/15 text-xs font-semibold text-primary">{initials}</span>
          <span className="hidden text-left leading-tight lg:block">
            <span className="block text-sm font-medium">{user.full_name}</span>
            <span className="block text-[11px] text-muted-foreground">{fmt.label(user.role)}</span>
          </span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel>
          <p className="truncate">{user.full_name}</p>
          <p className="truncate text-xs font-normal text-muted-foreground">{user.email}</p>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => navigate('/settings')}>
          <SettingsIcon /> Settings
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => logout()} className="text-destructive focus:text-destructive">
          <LogOut /> Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function ThemeToggle() {
  const { theme, toggle } = useTheme()
  return (
    <Button variant="ghost" size="icon" onClick={toggle} aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}>
      {theme === 'dark' ? <Sun /> : <Moon />}
    </Button>
  )
}

export function AppShell({ children }: { children?: ReactNode }) {
  const [mobileOpen, setMobileOpen] = useState(false)
  const { pathname } = useLocation()
  useEffect(() => setMobileOpen(false), [pathname])

  return (
    <div className="min-h-dvh lg:pl-64">
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[60] focus:rounded-md focus:bg-card focus:px-3 focus:py-2 focus:shadow">
        Skip to content
      </a>
      {/* Desktop sidebar */}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-64 flex-col bg-sidebar lg:flex">
        <Brand />
        <SidebarNav />
        <p className="px-6 py-4 text-[11px] text-sidebar-foreground/40">v1.0 · FastAPI · PostgreSQL · Redis</p>
      </aside>
      {/* Mobile drawer */}
      {mobileOpen && (
        <div className="fixed inset-0 z-50 lg:hidden" role="dialog" aria-modal="true" aria-label="Navigation">
          <div className="absolute inset-0 bg-black/50" onClick={() => setMobileOpen(false)} />
          <aside className="absolute inset-y-0 left-0 flex w-72 flex-col bg-sidebar shadow-xl">
            <div className="flex items-center justify-between pr-3">
              <Brand />
              <Button variant="ghost" size="icon" className="text-sidebar-foreground hover:bg-sidebar-accent" onClick={() => setMobileOpen(false)} aria-label="Close navigation">
                <X />
              </Button>
            </div>
            <SidebarNav onNavigate={() => setMobileOpen(false)} />
          </aside>
        </div>
      )}
      <header className="sticky top-0 z-20 flex h-16 items-center gap-3 border-b bg-background/85 px-4 backdrop-blur sm:px-6">
        <Button variant="ghost" size="icon" className="lg:hidden" onClick={() => setMobileOpen(true)} aria-label="Open navigation">
          <Menu />
        </Button>
        <Breadcrumbs />
        <div className="ml-auto flex items-center gap-1">
          <ThemeToggle />
          <Notifications />
          <div className="mx-1 h-6 w-px bg-border" aria-hidden />
          <UserMenu />
        </div>
      </header>
      <main id="main" className="mx-auto w-full max-w-[1600px] px-4 py-6 sm:px-6 lg:px-8">
        {children ?? <Outlet />}
      </main>
    </div>
  )
}
