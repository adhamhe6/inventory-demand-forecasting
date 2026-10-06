import * as DialogPrimitive from '@radix-ui/react-dialog'
import { useQuery } from '@tanstack/react-query'
import { Bell, ChevronRight, LogOut, Menu, Moon, PackageSearch, PanelLeftClose, PanelLeftOpen, Settings as SettingsIcon, Sun, X } from 'lucide-react'
import { type ReactNode, useEffect, useState } from 'react'
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
import { qk, useMeta } from '@/api/queries'
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
import { Tooltip } from '@/components/ui/tooltip'
import { api } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { useTheme } from '@/lib/theme'
import type { StockRiskPage } from '@/lib/types'
import { cn, fmt } from '@/lib/utils'
import { ALL_NAV, NAV_SECTIONS } from './nav'

function SidebarNav({ onNavigate, collapsed = false }: { onNavigate?: () => void; collapsed?: boolean }) {
  return (
    <nav aria-label="Main" className={cn('scrollbar-on-dark flex-1 overflow-y-auto overflow-x-hidden py-4', collapsed ? 'space-y-3 px-2' : 'space-y-6 px-3')}>
      {NAV_SECTIONS.map((section, i) => (
        <div key={section.title}>
          {/* Collapsed: the title stays available to screen readers; a hairline separates sections. */}
          <p className={cn('mb-2 px-3 text-[11px] font-semibold uppercase tracking-wider text-sidebar-foreground/50', collapsed && 'sr-only')}>{section.title}</p>
          {collapsed && i > 0 && <div className="mx-3 mb-3 h-px bg-sidebar-foreground/10" aria-hidden />}
          <ul className="space-y-0.5">
            {section.items.map((item) => {
              const link = (
                <NavLink
                  to={item.to}
                  end={item.to === '/'}
                  onClick={onNavigate}
                  className={({ isActive }) =>
                    cn(
                      'flex items-center gap-3 whitespace-nowrap rounded-lg py-2 text-sm font-medium text-sidebar-foreground/80 transition-colors hover:bg-sidebar-accent hover:text-white',
                      collapsed ? 'justify-center px-0' : 'px-3',
                      isActive && 'bg-sidebar-accent text-white shadow-sm',
                    )
                  }
                >
                  <item.icon className="size-4 shrink-0" aria-hidden />
                  <span className={cn(collapsed && 'sr-only')}>{item.label}</span>
                </NavLink>
              )
              return (
                <li key={item.to}>
                  {collapsed ? (
                    // Wrapped: the tooltip trigger merges className as a string, which would clobber
                    // NavLink's className function (active styling).
                    <Tooltip content={item.label} side="right">
                      <div>{link}</div>
                    </Tooltip>
                  ) : (
                    link
                  )}
                </li>
              )
            })}
          </ul>
        </div>
      ))}
    </nav>
  )
}

function Brand({ collapsed = false }: { collapsed?: boolean }) {
  return (
    <Link
      to="/"
      aria-label={collapsed ? 'StockSense home' : undefined}
      className={cn('flex items-center gap-2.5 whitespace-nowrap py-5 text-white', collapsed ? 'justify-center px-0' : 'px-6')}
    >
      <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground shadow">
        <PackageSearch className="size-4.5" aria-hidden />
      </span>
      <span className={cn('leading-tight', collapsed && 'hidden')}>
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
  const { data, isPending, isError, refetch } = useQuery({
    queryKey: qk.shortages({ min_risk: 'HIGH', page_size: 8 }),
    queryFn: () => api.get<StockRiskPage>('/shortages', { min_risk: 'HIGH', page_size: 8 }),
    refetchInterval: 120_000,
  })
  const count = data?.total ?? 0
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
          {isPending && <li className="px-4 py-8 text-center text-sm text-muted-foreground">Loading alerts…</li>}
          {isError && (
            <li className="px-4 py-6 text-center text-sm text-destructive">
              Could not load stock alerts.{' '}
              <button type="button" className="font-medium underline" onClick={() => refetch()}>
                Retry
              </button>
            </li>
          )}
          {data && count === 0 && <li className="px-4 py-8 text-center text-sm text-muted-foreground">No high-risk items.</li>}
          {data?.items.map((r) => (
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

function VersionFooter({ collapsed = false }: { collapsed?: boolean }) {
  const { data } = useMeta()
  if (collapsed) return null
  return (
    <p className="whitespace-nowrap px-6 py-4 text-[11px] text-sidebar-foreground/40">
      {data ? `v${data.version} · ${data.environment}` : 'StockSense'}
    </p>
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

const SIDEBAR_KEY = 'stocksense.sidebar-collapsed'

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_KEY) === '1'
  } catch {
    return false
  }
}

export function AppShell({ children }: { children?: ReactNode }) {
  const [mobileOpen, setMobileOpen] = useState(false)
  // Desktop only: the sidebar collapses to an icon rail to give the content more room.
  const [collapsed, setCollapsed] = useState(readCollapsed)
  const { pathname } = useLocation()
  useEffect(() => setMobileOpen(false), [pathname])
  const toggleCollapsed = () =>
    setCollapsed((c) => {
      try {
        localStorage.setItem(SIDEBAR_KEY, c ? '0' : '1')
      } catch {
        /* storage unavailable: the choice lasts for this page only */
      }
      return !c
    })

  return (
    <div className={cn('min-h-dvh transition-[padding] duration-200 ease-out motion-reduce:transition-none', collapsed ? 'lg:pl-[4.5rem]' : 'lg:pl-64')}>
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[60] focus:rounded-md focus:bg-card focus:px-3 focus:py-2 focus:shadow">
        Skip to content
      </a>
      {/* Desktop sidebar */}
      <aside
        id="app-sidebar"
        className={cn(
          'fixed inset-y-0 left-0 z-30 hidden flex-col overflow-hidden bg-sidebar transition-[width] duration-200 ease-out motion-reduce:transition-none lg:flex',
          collapsed ? 'w-[4.5rem]' : 'w-64',
        )}
      >
        <Brand collapsed={collapsed} />
        <SidebarNav collapsed={collapsed} />
        <VersionFooter collapsed={collapsed} />
      </aside>
      {/* Mobile drawer: Radix Dialog gives focus trapping, Escape to close and focus restore. */}
      <DialogPrimitive.Root open={mobileOpen} onOpenChange={setMobileOpen}>
        <DialogPrimitive.Portal>
          <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/50 lg:hidden" />
          <DialogPrimitive.Content
            aria-describedby={undefined}
            className="fixed inset-y-0 left-0 z-50 flex w-72 max-w-[85vw] flex-col bg-sidebar shadow-xl focus:outline-none lg:hidden"
          >
            <DialogPrimitive.Title className="sr-only">Navigation</DialogPrimitive.Title>
            <div className="flex items-center justify-between pr-3">
              <Brand />
              <DialogPrimitive.Close asChild>
                <Button variant="ghost" size="icon" className="text-sidebar-foreground hover:bg-sidebar-accent" aria-label="Close navigation">
                  <X />
                </Button>
              </DialogPrimitive.Close>
            </div>
            <SidebarNav onNavigate={() => setMobileOpen(false)} />
            <VersionFooter />
          </DialogPrimitive.Content>
        </DialogPrimitive.Portal>
      </DialogPrimitive.Root>
      <header className="sticky top-0 z-20 flex h-16 items-center gap-3 border-b bg-background/85 px-4 backdrop-blur sm:px-6">
        <Button variant="ghost" size="icon" className="lg:hidden" onClick={() => setMobileOpen(true)} aria-label="Open navigation">
          <Menu />
        </Button>
        <Tooltip content={collapsed ? 'Expand sidebar' : 'Collapse sidebar'} side="bottom">
          <Button
            variant="ghost"
            size="icon"
            className="hidden lg:inline-flex"
            onClick={toggleCollapsed}
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            aria-controls="app-sidebar"
            aria-expanded={!collapsed}
          >
            {collapsed ? <PanelLeftOpen /> : <PanelLeftClose />}
          </Button>
        </Tooltip>
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
