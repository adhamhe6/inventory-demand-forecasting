import { Activity, Info, UserRound, Users } from 'lucide-react'
import { useSearchParams } from 'react-router-dom'
import { PageHeader } from '@/components/common/PageHeader'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useAuth } from '@/lib/auth'
import { AboutTab } from './settings/AboutTab'
import { JobsTab } from './settings/JobsTab'
import { ProfileTab } from './settings/ProfileTab'
import { UsersTab } from './settings/UsersTab'

export default function SettingsPage() {
  const { can } = useAuth()
  const [params, setParams] = useSearchParams()
  const tabs = [
    { id: 'profile', label: 'Profile', icon: UserRound, el: ProfileTab },
    ...(can('manage_users') ? [{ id: 'users', label: 'Users', icon: Users, el: UsersTab }] : []),
    { id: 'jobs', label: 'Background jobs', icon: Activity, el: JobsTab },
    { id: 'about', label: 'About', icon: Info, el: AboutTab },
  ]
  const raw = params.get('tab')
  const tab = tabs.some((t) => t.id === raw) ? raw! : 'profile'

  return (
    <>
      <PageHeader title="Settings" description="Your profile, team access, background processing and system information." />
      <Tabs value={tab} onValueChange={(v) => setParams(v === 'profile' ? {} : { tab: v }, { replace: true })}>
        <TabsList aria-label="Settings sections" className="w-full justify-start sm:w-auto">
          {tabs.map((t) => (
            <TabsTrigger key={t.id} value={t.id}>
              <t.icon aria-hidden /> {t.label}
            </TabsTrigger>
          ))}
        </TabsList>
        {tabs.map((t) => (
          <TabsContent key={t.id} value={t.id} className="mt-6">
            <t.el />
          </TabsContent>
        ))}
      </Tabs>
    </>
  )
}
