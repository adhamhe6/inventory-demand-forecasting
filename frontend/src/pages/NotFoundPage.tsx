import { Link } from 'react-router-dom'
import { EmptyState } from '@/components/common/States'
import { Button } from '@/components/ui/button'

export default function NotFoundPage() {
  return (
    <>
      <h1 className="sr-only">Page not found</h1>
      <EmptyState
        title="Page not found"
        description="The page you are looking for doesn't exist or has moved."
        action={
          <Button asChild>
            <Link to="/">Back to dashboard</Link>
          </Button>
        }
      />
    </>
  )
}
