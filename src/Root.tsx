import { lazy, Suspense } from 'react'
import App from './App'

const AdminApp = lazy(() => import('./AdminApp'))

function Root() {
  return window.location.pathname.replace(/\/+$/, '') === '/admin' ? (
    <Suspense fallback={<div className="portal-loading" role="status">Opening the secure store portal...</div>}>
      <AdminApp />
    </Suspense>
  ) : (
    <App />
  )
}

export default Root
