import { useEffect, useMemo, useState, type FormEvent } from 'react'
import {
  ArrowLeft,
  ArrowRight,
  BadgeCheck,
  Boxes,
  ChartNoAxesColumnIncreasing,
  CircleAlert,
  Clock3,
  LayoutDashboard,
  LogOut,
  Package,
  Pencil,
  Plus,
  RefreshCw,
  ShieldCheck,
  ShoppingBag,
  Trash2,
  Users,
} from 'lucide-react'
import {
  getIdTokenResult,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut,
  type User,
} from 'firebase/auth'
import {
  collection,
  deleteField,
  deleteDoc,
  doc,
  type DocumentData,
  getDocs,
  limit,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  type QueryDocumentSnapshot,
} from 'firebase/firestore'
import { auth, db, isFirebaseConfigured } from './lib/firebase'
import type { Product } from './types'
import './AdminApp.css'

type AdminPage = 'overview' | 'products' | 'orders' | 'customers'
type OrderStatus = 'pending' | 'confirmed' | 'shipped' | 'delivered' | 'cancelled'
type PaymentStatus = 'pending' | 'paid' | 'cancelled'
const allowedOrderTransitions: Record<OrderStatus, OrderStatus[]> = {
  pending: ['confirmed', 'cancelled'],
  confirmed: ['shipped', 'cancelled'],
  shipped: ['delivered', 'cancelled'],
  delivered: [],
  cancelled: [],
}
type AdminOrder = {
  id: string
  orderNumber: string
  userId: string
  customerEmail: string
  customer: { fullName: string; phone: string; address: string; city: string }
  items: { id: string; productId: string; name: string; quantity: number; lineTotal: number }[]
  itemCount?: number
  itemsCompleteness: 'complete' | 'incomplete' | 'legacy'
  subtotal: number
  deliveryFee: number
  total: number
  status: OrderStatus
  paymentMethod: 'cod'
  paymentStatus: PaymentStatus
  createdAt: { toDate: () => Date }
}
type AdminCustomer = {
  id: string
  email: string
  displayName: string
  createdAt: { toDate: () => Date }
}
type DashboardData = {
  totals: { orders: number; customers: number; products: number; revenue: number }
  revenueByMonth: { key: string; label: string; revenue: number }[]
  bestSellers: { id: string; name: string; soldCount: number; price: number }[]
  lowStock: { id: string; name: string; stock: number }[]
  lowStockCount: number
}
type ProductDraft = {
  name: string
  brand: string
  category: string
  description: string
  price: string
  compareAtPrice: string
  stock: string
  imageUrl: string
  imageAlt: string
  imagePath: string
  badge: string
  featured: boolean
  published: boolean
}

async function loadAdminOrders(
  orderDocs: QueryDocumentSnapshot<DocumentData>[],
): Promise<AdminOrder[]> {
  return Promise.all(orderDocs.map(async (orderDoc) => {
    const data = orderDoc.data()
    const legacyItems = Array.isArray(data.items)
      ? data.items as Omit<AdminOrder['items'][number], 'id'>[]
      : null
    let items: AdminOrder['items']
    let itemsCompleteness: AdminOrder['itemsCompleteness']

    if (legacyItems) {
      items = legacyItems.map((item) => ({ ...item, id: item.productId }))
      itemsCompleteness = 'legacy'
    } else {
      const itemSnapshot = await getDocs(collection(orderDoc.ref, 'items'))
      items = itemSnapshot.docs.map((itemDoc) => ({
        id: itemDoc.id,
        ...itemDoc.data(),
      })) as AdminOrder['items']
      itemsCompleteness = Number.isInteger(data.itemCount)
        && data.itemCount > 0
        && items.length === data.itemCount
        ? 'complete'
        : 'incomplete'
    }

    return {
      id: orderDoc.id,
      ...data,
      items,
      itemsCompleteness,
    } as AdminOrder
  }))
}

const emptyDraft: ProductDraft = {
  name: '',
  brand: '',
  category: '',
  description: '',
  price: '',
  compareAtPrice: '',
  stock: '',
  imageUrl: '',
  imageAlt: '',
  imagePath: '',
  badge: '',
  featured: false,
  published: false,
}

const navigation: { id: AdminPage; label: string; icon: typeof LayoutDashboard }[] = [
  { id: 'overview', label: 'Overview', icon: LayoutDashboard },
  { id: 'products', label: 'Products', icon: Package },
  { id: 'orders', label: 'Orders', icon: ShoppingBag },
  { id: 'customers', label: 'Customers', icon: Users },
]

function price(value: number) {
  return new Intl.NumberFormat('en-PK', {
    style: 'currency',
    currency: 'PKR',
    maximumFractionDigits: 0,
  }).format(value)
}

function isValidProductImageUrl(imageUrl: string) {
  if (!imageUrl.trim() || imageUrl.trim().length > 1500) return false
  try {
    const url = new URL(imageUrl)
    return url.protocol === 'https:'
  } catch {
    return false
  }
}

function statusUpdateErrorMessage(error: unknown) {
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
  if (code.includes('permission-denied')) {
    return 'Firestore rules rejected this status change. The transition may not be allowed or this account may not have admin access.'
  }
  if (code.includes('unavailable') || code.includes('network') || code.includes('deadline-exceeded')) {
    return 'Firestore could not be reached. The order status was not confirmed as updated.'
  }
  return 'That order could not be updated. Check its current status and try again.'
}

function productWriteErrorMessage(error: unknown) {
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
  if (code.includes('permission-denied')) {
    return 'Firestore rules rejected the product change. Confirm this account has the trusted admin claim.'
  }
  if (code.includes('unavailable') || code.includes('network') || code.includes('deadline-exceeded')) {
    return 'Firestore could not be reached. The product change was not confirmed.'
  }
  return 'Product could not be saved. Check every field and try again.'
}

function dateLabel(value: AdminOrder['createdAt'] | AdminCustomer['createdAt']) {
  return value?.toDate ? value.toDate().toLocaleDateString() : 'Recently'
}

function AdminApp() {
  const [user, setUser] = useState<User | null>(null)
  const [authorization, setAuthorization] = useState<'checking' | 'allowed' | 'denied'>(
    auth ? 'checking' : 'denied',
  )
  const [page, setPage] = useState<AdminPage>('overview')
  const [dashboard, setDashboard] = useState<DashboardData | null>(null)
  const [products, setProducts] = useState<Product[]>([])
  const [orders, setOrders] = useState<AdminOrder[]>([])
  const [customers, setCustomers] = useState<AdminCustomer[]>([])
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [editingProduct, setEditingProduct] = useState<Product | null>(null)
  const [productDraft, setProductDraft] = useState<ProductDraft>(emptyDraft)

  useEffect(() => {
    if (!auth) return
    return onAuthStateChanged(auth, (currentUser) => {
      setUser(currentUser)
      if (!currentUser) {
        setAuthorization('denied')
        return
      }
      setAuthorization('checking')
      void getIdTokenResult(currentUser, true)
        .then((token) => {
          setAuthorization(token.claims.admin === true ? 'allowed' : 'denied')
          if (token.claims.admin !== true) {
            setError('This account does not have the trusted administrator claim.')
          } else {
            setError('')
          }
        })
        .catch((cause: unknown) => {
          console.error('Unable to verify the administrator claim.', cause)
          setAuthorization('denied')
          setError('We could not verify administrator access. Please sign in again.')
        })
    })
  }, [])

  useEffect(() => {
    if (authorization !== 'allowed' || !db) return
    const firestore = db
    let active = true
    const loadAdminData = async () => {
      setLoading(true)
      setError('')
      try {
        const [productSnapshot, orderSnapshot, customerSnapshot] = await Promise.all([
          getDocs(query(collection(firestore, 'products'), orderBy('updatedAt', 'desc'), limit(100))),
          getDocs(query(collection(firestore, 'orders'), orderBy('createdAt', 'desc'), limit(50))),
          getDocs(query(collection(firestore, 'users'), orderBy('createdAt', 'desc'), limit(100))),
        ])
        if (!active) return
        const productList = productSnapshot.docs.map((item) => ({ id: item.id, ...item.data() })) as Product[]
        const orderList = await loadAdminOrders(orderSnapshot.docs)
        if (!active) return
        const customerList = customerSnapshot.docs.map((item) => ({ id: item.id, ...item.data() })) as AdminCustomer[]
        const revenue = orderList
          .filter((order) => order.paymentStatus === 'paid' && order.itemsCompleteness !== 'incomplete')
          .reduce((sum, order) => sum + order.total, 0)
        const revenueByMonth = Array.from({ length: 6 }, (_, index) => {
          const date = new Date()
          date.setMonth(date.getMonth() - index)
          const monthKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
          const label = date.toLocaleString('en-US', { month: 'short' })
          const value = orderList
            .filter((order) =>
              order.paymentStatus === 'paid' &&
              order.itemsCompleteness !== 'incomplete' &&
              order.createdAt?.toDate,
            )
            .reduce((sum, order) => {
              const createdAt = order.createdAt.toDate()
              const sameMonth = createdAt.getFullYear() === date.getFullYear() && createdAt.getMonth() === date.getMonth()
              return sameMonth ? sum + order.total : sum
            }, 0)
          return { key: monthKey, label, revenue: value }
        }).reverse()
        const soldCounts = new Map<string, number>()
        for (const order of orderList) {
          if (order.itemsCompleteness === 'incomplete') continue
          for (const item of order.items) {
            soldCounts.set(item.productId, (soldCounts.get(item.productId) ?? 0) + item.quantity)
          }
        }
        const bestSellers = productList
          .map((product) => ({
            id: product.id,
            name: product.name,
            soldCount: soldCounts.get(product.id) ?? 0,
            price: product.price,
          }))
          .sort((a, b) => (b.soldCount ?? 0) - (a.soldCount ?? 0))
          .slice(0, 5)
        const summary: DashboardData = {
          totals: {
            orders: orderList.length,
            customers: customerList.length,
            products: productList.length,
            revenue,
          },
          revenueByMonth,
          bestSellers,
          lowStock: productList.filter((product) => product.stock <= 5).slice(0, 5),
          lowStockCount: productList.filter((product) => product.stock <= 5).length,
        }
        setDashboard(summary)
        setProducts(productList)
        setOrders(orderList)
        setCustomers(customerList)
      } catch (cause) {
        if (!active) return
        console.error('Unable to load administrator data.', cause)
        setError('Dashboard data could not be loaded. Check your connection and administrator permissions.')
      } finally {
        if (active) setLoading(false)
      }
    }
    void loadAdminData()
    return () => {
      active = false
    }
  }, [authorization])

  const maxRevenue = Math.max(1, ...(dashboard?.revenueByMonth.map((month) => month.revenue) ?? []))
  const lowStockCount = dashboard?.lowStockCount ?? 0

  function startProductEdit(product: Product) {
    setEditingProduct(product)
    setProductDraft({
      name: product.name,
      brand: product.brand,
      category: product.category,
      description: product.description,
      price: String(product.price),
      compareAtPrice: String(product.compareAtPrice),
      stock: String(product.stock),
      imageUrl: product.imageUrl,
      imageAlt: product.imageAlt,
      imagePath: product.imagePath ?? '',
      badge: product.badge ?? '',
      featured: product.featured,
      published: product.published,
    })
    setPage('products')
    setMessage('')
  }

  function clearProductEditor() {
    setEditingProduct(null)
    setProductDraft(emptyDraft)
  }

  function updateDraft<Key extends keyof ProductDraft>(key: Key, value: ProductDraft[Key]) {
    setProductDraft((current) => ({ ...current, [key]: value }))
  }

  async function submitLogin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!auth) {
      setError('Firebase Authentication is not configured.')
      return
    }
    const values = new FormData(event.currentTarget)
    setBusy(true)
    setError('')
    try {
      await signInWithEmailAndPassword(
        auth,
        String(values.get('email') ?? '').trim(),
        String(values.get('password') ?? ''),
      )
    } catch (cause) {
      console.error('Administrator sign-in failed.', cause)
      setError('Sign-in was not successful. Check the email and password, then try again.')
    } finally {
      setBusy(false)
    }
  }

  async function refreshData() {
    if (!auth?.currentUser) return
    setLoading(true)
    setError('')
    try {
      const token = await getIdTokenResult(auth.currentUser, true)
      if (token.claims.admin !== true) {
        setAuthorization('denied')
        setError('This account does not have the trusted administrator claim.')
        return
      }
      await reloadCollections()
    } catch (cause) {
      console.error('Unable to refresh administrator data.', cause)
      setError('We could not refresh the dashboard. Check your connection and try again.')
    } finally {
      setLoading(false)
    }
  }

  async function logout() {
    if (!auth) return
    try {
      await signOut(auth)
      setPage('overview')
      setMessage('')
      setError('')
    } catch (cause) {
      console.error('Administrator sign-out failed.', cause)
      setError('We could not sign you out. Please try again.')
    }
  }

  async function saveProduct(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy) return
    if (!db) {
      setError('Firestore is not configured.')
      return
    }
    const name = productDraft.name.trim()
    const brand = productDraft.brand.trim()
    const category = productDraft.category.trim()
    const description = productDraft.description.trim()
    const imageAlt = productDraft.imageAlt.trim()
    const badge = productDraft.badge.trim()
    const imagePath = productDraft.imagePath.trim()
    if (name.length < 2 || name.length > 120) {
      setError('Product name must contain 2–120 characters.')
      return
    }
    if (brand.length < 1 || brand.length > 80) {
      setError('Brand must contain 1–80 characters.')
      return
    }
    if (category.length < 1 || category.length > 80) {
      setError('Category must contain 1–80 characters.')
      return
    }
    if (description.length < 1 || description.length > 3000) {
      setError('Description must contain 1–3,000 characters.')
      return
    }
    if (imageAlt.length < 2 || imageAlt.length > 180) {
      setError('Image description must contain 2–180 characters.')
      return
    }
    if (badge.length > 30) {
      setError('Badge must be 30 characters or fewer.')
      return
    }
    if (!isValidProductImageUrl(productDraft.imageUrl)) {
      setError('Add a valid HTTPS image URL (up to 1,500 characters).')
      return
    }
    if (
      !productDraft.price.trim() ||
      !productDraft.compareAtPrice.trim() ||
      !productDraft.stock.trim()
    ) {
      setError('Enter a current price, original price, and stock quantity.')
      return
    }
    const numericPrice = Number(productDraft.price)
    const numericCompareAtPrice = Number(productDraft.compareAtPrice)
    const numericStock = Number(productDraft.stock)
    if (
      !Number.isFinite(numericPrice) ||
      numericPrice < 0 ||
      numericPrice > 100000000 ||
      !Number.isFinite(numericCompareAtPrice) ||
      numericCompareAtPrice < numericPrice ||
      numericCompareAtPrice > 100000000
    ) {
      setError('Prices must be finite, non-negative, no more than PKR 100,000,000, and the original price cannot be below the current price.')
      return
    }
    if (!Number.isSafeInteger(numericStock) || numericStock < 0 || numericStock > 100000) {
      setError('Stock must be a whole number between 0 and 100,000.')
      return
    }

    setBusy(true)
    setError('')
    setMessage('')
    try {
      const product = {
        name,
        brand,
        category,
        description,
        price: numericPrice,
        compareAtPrice: numericCompareAtPrice,
        stock: numericStock,
        imageUrl: productDraft.imageUrl.trim(),
        imageAlt,
        featured: productDraft.featured,
        published: productDraft.published,
        updatedAt: serverTimestamp(),
      }
      if (editingProduct) {
        await updateDoc(doc(db, 'products', editingProduct.id), {
          ...product,
          ...(imagePath ? { imagePath } : { imagePath: deleteField() }),
          ...(badge ? { badge } : { badge: deleteField() }),
        })
      } else {
        const id = crypto.randomUUID()
        await setDoc(doc(db, 'products', id), {
          ...product,
          ...(imagePath ? { imagePath } : {}),
          ...(badge ? { badge } : {}),
          createdAt: serverTimestamp(),
        })
      }
      clearProductEditor()
      setMessage(editingProduct ? 'Product changes saved.' : 'Product added to the catalogue.')
      try {
        await reloadCollections()
      } catch (refreshError) {
        console.error('Product was saved, but the administrator lists could not be refreshed.', refreshError)
        setError('Product was saved, but the administrator lists could not be refreshed.')
      }
    } catch (cause) {
      console.error('Product could not be saved.', cause)
      setError(productWriteErrorMessage(cause))
    } finally {
      setBusy(false)
    }
  }

  async function deleteProduct(product: Product) {
    if (!db || busy) return
    if (!window.confirm(`Delete "${product.name}" from the catalogue? This cannot be undone.`)) return
    setBusy(true)
    setError('')
    setMessage('')
    try {
      await deleteDoc(doc(db, 'products', product.id))
      setMessage('Product deleted.')
    } catch (cause) {
      console.error('Product deletion failed.', cause)
      setError('The product was not deleted. Please check your administrator access and try again.')
      setBusy(false)
      return
    }
    try {
      await reloadCollections()
    } catch (refreshError) {
      console.error('Product was deleted, but the administrator lists could not be refreshed.', refreshError)
      setError('Product was deleted, but the administrator lists could not be refreshed.')
    } finally {
      setBusy(false)
    }
  }

  async function changeOrderStatus(order: AdminOrder, status: OrderStatus, paymentStatus?: PaymentStatus) {
    if (!db || busy) return
    if (status !== order.status && !allowedOrderTransitions[order.status].includes(status)) {
      setError('That order status transition is not allowed.')
      return
    }
    if (status === 'cancelled' && order.paymentStatus === 'paid') {
      setError('A paid order cannot be cancelled without a refund process.')
      return
    }
    if (
      paymentStatus &&
      !(paymentStatus === order.paymentStatus ||
        (paymentStatus === 'paid' && order.status === 'delivered' && order.paymentStatus === 'pending'))
    ) {
      setError('Payment status can only be marked paid after delivery. No refund workflow is available.')
      return
    }
    setBusy(true)
    setError('')
    setMessage('')
    try {
      await updateDoc(doc(db, 'orders', order.id), {
        status,
        ...(paymentStatus ? { paymentStatus } : {}),
        updatedAt: serverTimestamp(),
      })
    } catch (cause) {
      console.error('Order status update failed.', cause)
      setError(statusUpdateErrorMessage(cause))
      setBusy(false)
      return
    }
    setMessage(`${order.orderNumber} updated.`)
    try {
      await reloadCollections()
    } catch (refreshError) {
      console.error('Order was updated, but the administrator lists could not be refreshed.', refreshError)
      setError('Order was updated, but the administrator lists could not be refreshed.')
    } finally {
      setBusy(false)
    }
  }

  async function reloadCollections() {
    if (!db) return
    const firestore = db
    const [productSnapshot, orderSnapshot, customerSnapshot] = await Promise.all([
      getDocs(query(collection(firestore, 'products'), orderBy('updatedAt', 'desc'), limit(100))),
      getDocs(query(collection(firestore, 'orders'), orderBy('createdAt', 'desc'), limit(50))),
      getDocs(query(collection(firestore, 'users'), orderBy('createdAt', 'desc'), limit(100))),
    ])
    const productList = productSnapshot.docs.map((item) => ({ id: item.id, ...item.data() })) as Product[]
    const orderList = await loadAdminOrders(orderSnapshot.docs)
    const customerList = customerSnapshot.docs.map((item) => ({ id: item.id, ...item.data() })) as AdminCustomer[]
    const revenue = orderList
      .filter((order) => order.paymentStatus === 'paid' && order.itemsCompleteness !== 'incomplete')
      .reduce((sum, order) => sum + order.total, 0)
    const revenueByMonth = Array.from({ length: 6 }, (_, index) => {
      const date = new Date()
      date.setMonth(date.getMonth() - index)
      const monthKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
      const label = date.toLocaleString('en-US', { month: 'short' })
      const value = orderList
        .filter((order) =>
          order.paymentStatus === 'paid' &&
          order.itemsCompleteness !== 'incomplete' &&
          order.createdAt?.toDate,
        )
        .reduce((sum, order) => {
          const createdAt = order.createdAt.toDate()
          const sameMonth = createdAt.getFullYear() === date.getFullYear() && createdAt.getMonth() === date.getMonth()
          return sameMonth ? sum + order.total : sum
        }, 0)
      return { key: monthKey, label, revenue: value }
    }).reverse()
    const soldCounts = new Map<string, number>()
    for (const order of orderList) {
      if (order.itemsCompleteness === 'incomplete') continue
      for (const item of order.items) {
        soldCounts.set(item.productId, (soldCounts.get(item.productId) ?? 0) + item.quantity)
      }
    }
    setDashboard({
      totals: {
        orders: orderList.length,
        customers: customerList.length,
        products: productList.length,
        revenue,
      },
      revenueByMonth,
      bestSellers: productList
        .map((product) => ({
          id: product.id,
          name: product.name,
          soldCount: soldCounts.get(product.id) ?? 0,
          price: product.price,
        }))
        .sort((a, b) => (b.soldCount ?? 0) - (a.soldCount ?? 0))
        .slice(0, 5),
      lowStock: productList.filter((product) => product.stock <= 5).slice(0, 5),
      lowStockCount: productList.filter((product) => product.stock <= 5).length,
    })
    setProducts(productList)
    setOrders(orderList)
    setCustomers(customerList)
  }

  if (!isFirebaseConfigured) {
    return <AdminGate error="Firebase is not configured. Add the project settings to your local .env file before opening the admin dashboard." configurationReady={false} />
  }

  if (!user || authorization === 'denied') {
    return (
      <AdminGate error={error} onSubmit={(event) => void submitLogin(event)} busy={busy} />
    )
  }

  if (authorization === 'checking') {
    return <AdminGate loading />
  }

  return (
    <div className="admin-shell">
      <aside className="admin-sidebar">
        <a className="admin-brand" href="/" aria-label="KK Collection storefront">
          <span>KK</span><small>COLLECTION</small>
        </a>
        <p className="admin-caption">STORE MANAGEMENT</p>
        <nav className="admin-nav" aria-label="Administrator pages">
          {navigation.map(({ id, label, icon: Icon }) => (
            <button type="button" className={page === id ? 'selected' : ''} key={id} onClick={() => setPage(id)}>
              <Icon size={17} aria-hidden="true" /><span>{label}</span>
              {id === 'orders' && orders.filter((order) => order.status === 'pending').length > 0 && (
                <small>{orders.filter((order) => order.status === 'pending').length}</small>
              )}
            </button>
          ))}
        </nav>
        <div className="admin-sidebar-bottom">
          <div className="admin-verified"><ShieldCheck size={16} /><span>Verified administrator</span></div>
          <button type="button" onClick={() => void logout()}><LogOut size={16} /> Sign out</button>
          <a href="/"><ArrowLeft size={15} /> View storefront</a>
        </div>
      </aside>

      <main className="admin-main">
        <header className="admin-topbar">
          <div><p className="admin-caption">KK COLLECTION / ADMIN</p><h1>{navigation.find((item) => item.id === page)?.label}</h1></div>
          <div className="admin-top-actions">
            <span className="admin-user-email">{user.email}</span>
            <button className="admin-refresh" type="button" onClick={() => void refreshData()} disabled={loading || busy} aria-label="Refresh dashboard data"><RefreshCw size={16} /></button>
          </div>
        </header>

        {(error || message) && (
          <div className={`admin-alert ${error ? 'is-error' : 'is-success'}`} role={error ? 'alert' : 'status'}>
            {error ? <CircleAlert size={17} /> : <BadgeCheck size={17} />}
            <span>{error || message}</span>
            <button type="button" aria-label="Dismiss message" onClick={() => { setError(''); setMessage('') }}>×</button>
          </div>
        )}

        {loading && <div className="admin-loading" role="status"><span /> Loading secure store data...</div>}
        {!loading && page === 'overview' && (
          <Overview
            data={dashboard}
            orders={orders.slice(0, 6)}
            maxRevenue={maxRevenue}
            lowStockCount={lowStockCount}
            goTo={setPage}
          />
        )}
        {!loading && page === 'products' && (
          <ProductManagement
            products={products}
            busy={busy}
            draft={productDraft}
            editingProduct={editingProduct}
            updateDraft={updateDraft}
            edit={startProductEdit}
            remove={(product) => void deleteProduct(product)}
            cancel={clearProductEditor}
            submit={(event) => void saveProduct(event)}
          />
        )}
        {!loading && page === 'orders' && (
          <OrderManagement orders={orders} busy={busy} update={(order, status, paymentStatus) => void changeOrderStatus(order, status, paymentStatus)} />
        )}
        {!loading && page === 'customers' && <CustomerManagement customers={customers} />}
      </main>
    </div>
  )
}

function AdminGate({
  error = '',
  loading = false,
  busy = false,
  configurationReady = true,
  onSubmit,
}: {
  error?: string
  loading?: boolean
  busy?: boolean
  configurationReady?: boolean
  onSubmit?: (event: FormEvent<HTMLFormElement>) => void
}) {
  return (
    <main className="admin-gate">
      <a className="admin-gate-back" href="/"><ArrowLeft size={15} /> Back to KK Collection</a>
      <section className="admin-gate-card">
        <div className="admin-shield"><ShieldCheck size={25} /></div>
        <p className="admin-caption">KK COLLECTION · PRIVATE AREA</p>
        <h1>Administrator<br />sign in.</h1>
        <p className="admin-gate-copy">This area is for authorized store administrators only. Access is verified by a trusted Firebase claim.</p>
        {loading ? (
          <div className="admin-loading"><span /> Verifying administrator access...</div>
        ) : (
          <form onSubmit={onSubmit}>
            <label>Email address<input name="email" type="email" autoComplete="username" required maxLength={254} /></label>
            <label>Password<input name="password" type="password" autoComplete="current-password" required /></label>
            {error && <p className="admin-gate-error" role="alert"><CircleAlert size={15} />{error}</p>}
            <button type="submit" className="admin-primary-button" disabled={busy || !configurationReady}>{busy ? 'Checking access...' : 'Sign in securely'} <ArrowRight size={16} /></button>
          </form>
        )}
      </section>
      <p className="admin-gate-footnote">Administrator privileges can only be assigned by a trusted project owner.</p>
    </main>
  )
}

function Overview({
  data,
  orders,
  maxRevenue,
  lowStockCount,
  goTo,
}: {
  data: DashboardData | null
  orders: AdminOrder[]
  maxRevenue: number
  lowStockCount: number
  goTo: (page: AdminPage) => void
}) {
  if (!data) return <p className="admin-empty">Dashboard totals are not available.</p>
  const stats = [
    { label: 'Paid request totals · latest 50', value: price(data.totals.revenue), icon: ChartNoAxesColumnIncreasing, note: 'Uses customer-submitted totals; not independently verified' },
    { label: 'Orders · latest 50', value: data.totals.orders.toLocaleString(), icon: ShoppingBag, note: 'Most recent records only' },
    { label: 'Customers · latest 100', value: data.totals.customers.toLocaleString(), icon: Users, note: 'Most recent records only' },
    { label: 'Products · latest 100', value: data.totals.products.toLocaleString(), icon: Boxes, note: `${lowStockCount} low-stock items in this sample` },
  ]
  return (
    <div className="admin-page-content">
      <div className="admin-welcome"><div><p className="admin-caption">YOUR STORE, AT A GLANCE</p><h2>A good day to do good things.</h2></div><button className="admin-outline-button" type="button" onClick={() => goTo('products')}><Plus size={15} /> Add a product</button></div>
      <section className="stats-grid" aria-label="Dashboard metrics from limited query results">
        {stats.map(({ label, value, icon: Icon, note }) => (
          <article className="stat-card" key={label}><div className="stat-top"><span>{label}</span><Icon size={17} /></div><strong>{value}</strong><small>{note}</small></article>
        ))}
      </section>
      <div className="admin-overview-grid">
        <section className="admin-card revenue-card">
          <div className="admin-card-heading"><div><p className="admin-caption">PAID REQUEST TOTALS · LATEST 50 LOADED</p><h3>Reported paid totals</h3></div><span className="revenue-mark">PKR</span></div>
          <p className="admin-empty">Amounts come from unverified customer requests and are not audited accounting totals.</p>
          <div className="revenue-chart" role="img" aria-label="Customer-submitted totals of orders marked paid among the latest 50 loaded orders for the last six months">
            {data.revenueByMonth.map((month) => (
              <div className="revenue-column" key={month.key} title={`${month.label}: ${price(month.revenue)}`}>
                <span className="revenue-value">{month.revenue > 0 ? `${Math.round(month.revenue / 1000)}k` : ''}</span>
                <div className="revenue-bar-track"><span style={{ height: `${Math.max(3, (month.revenue / maxRevenue) * 100)}%` }} /></div>
                <small>{month.label}</small>
              </div>
            ))}
          </div>
        </section>
        <section className="admin-card stock-card">
          <div className="admin-card-heading"><div><p className="admin-caption">LATEST 100 PRODUCTS · LIST CAPPED AT 5</p><h3>Low stock</h3></div><button type="button" className="admin-link-button" onClick={() => goTo('products')}>All products <ArrowRight size={14} /></button></div>
          {data.lowStock.length === 0 ? <p className="admin-empty">Everything is comfortably stocked.</p> : (
            <ul className="stock-list">{data.lowStock.slice(0, 5).map((product) => <li key={product.id}><span>{product.name}</span><strong>{product.stock} left</strong></li>)}</ul>
          )}
        </section>
      </div>
      <section className="admin-card recent-orders">
        <div className="admin-card-heading"><div><p className="admin-caption">LATEST 6 OF UP TO 50 LOADED</p><h3>Recent orders</h3></div><button type="button" className="admin-link-button" onClick={() => goTo('orders')}>View all <ArrowRight size={14} /></button></div>
        {orders.length === 0 ? <p className="admin-empty">Your first order will appear here.</p> : <OrderTable orders={orders} compact />}
      </section>
      <section className="admin-card best-sellers">
        <div className="admin-card-heading"><div><p className="admin-caption">LATEST 50 LOADED REQUESTS · INCLUDES CANCELLED</p><h3>Most requested products</h3></div></div>
        <p className="admin-empty">Incomplete requests are excluded from product counts and paid-total summaries. All submitted prices and quantities remain unverified.</p>
        {data.bestSellers.length === 0 ? <p className="admin-empty">Product requests will appear here once customers submit them.</p> : (
          <div className="seller-list">{data.bestSellers.map((product, index) => <div key={product.id}><span className="seller-rank">0{index + 1}</span><strong>{product.name}</strong><span>{product.soldCount ?? 0} requested</span><span>{price(product.price)}</span></div>)}</div>
        )}
      </section>
    </div>
  )
}

function ProductManagement({
  products,
  busy,
  draft,
  editingProduct,
  updateDraft,
  edit,
  remove,
  cancel,
  submit,
}: {
  products: Product[]
  busy: boolean
  draft: ProductDraft
  editingProduct: Product | null
  updateDraft: <Key extends keyof ProductDraft>(key: Key, value: ProductDraft[Key]) => void
  edit: (product: Product) => void
  remove: (product: Product) => void
  cancel: () => void
  submit: (event: FormEvent<HTMLFormElement>) => void
}) {
  return (
    <div className="admin-page-content">
      <section className="admin-card product-editor">
        <div className="admin-card-heading"><div><p className="admin-caption">{editingProduct ? 'UPDATE THE DETAILS' : 'ADD TO YOUR EDIT'}</p><h3>{editingProduct ? 'Edit product' : 'New product'}</h3></div>{editingProduct && <button className="admin-link-button" type="button" onClick={cancel}>Cancel edit</button>}</div>
        <form className="product-form" onSubmit={submit}>
          <label>Product name<input value={draft.name} onChange={(event) => updateDraft('name', event.target.value)} required minLength={2} maxLength={120} /></label>
          <label>Brand<input value={draft.brand} onChange={(event) => updateDraft('brand', event.target.value)} required maxLength={80} /></label>
          <label>Category<input value={draft.category} onChange={(event) => updateDraft('category', event.target.value)} required maxLength={80} placeholder="Skincare, Makeup..." /></label>
          <label>Price (PKR)<input type="number" value={draft.price} onChange={(event) => updateDraft('price', event.target.value)} min="0" max="100000000" step="1" required /></label>
          <label>Original price (PKR)<input type="number" value={draft.compareAtPrice} onChange={(event) => updateDraft('compareAtPrice', event.target.value)} min="0" max="100000000" step="1" required /></label>
          <label>Stock quantity<input type="number" value={draft.stock} onChange={(event) => updateDraft('stock', event.target.value)} min="0" max="100000" step="1" required /></label>
          <label className="form-wide">Description<textarea value={draft.description} onChange={(event) => updateDraft('description', event.target.value)} required minLength={1} maxLength={3000} rows={3} /></label>
          <label>Image description<input value={draft.imageAlt} onChange={(event) => updateDraft('imageAlt', event.target.value)} required minLength={2} maxLength={180} /></label>
          <label>Badge (optional)<input value={draft.badge} onChange={(event) => updateDraft('badge', event.target.value)} maxLength={30} placeholder="New, Best seller..." /></label>
          <label className="form-wide">Image URL<input value={draft.imageUrl} onChange={(event) => updateDraft('imageUrl', event.target.value)} placeholder="https://images.unsplash.com/..." required maxLength={1500} /></label>
          <div className="form-checkboxes form-wide">
            <label><input type="checkbox" checked={draft.published} onChange={(event) => updateDraft('published', event.target.checked)} /> Published in store</label>
            <label><input type="checkbox" checked={draft.featured} onChange={(event) => updateDraft('featured', event.target.checked)} /> Featured product</label>
          </div>
          <div className="product-form-actions form-wide"><button className="admin-primary-button" type="submit" disabled={busy}>{busy ? 'Saving product...' : editingProduct ? 'Save changes' : 'Add product'} <ArrowRight size={15} /></button></div>
        </form>
      </section>
      <section className="admin-card admin-product-list">
        <div className="admin-card-heading"><div><p className="admin-caption">LATEST 100 LOADED</p><h3>Products <span className="admin-count">{products.length}</span></h3></div></div>
        {products.length === 0 ? <p className="admin-empty">No products yet. Add your first product above.</p> : (
          <div className="admin-table-scroll"><table className="admin-table"><thead><tr><th>Product</th><th>Category</th><th>Price</th><th>Stock</th><th>Status</th><th>Actions</th></tr></thead><tbody>
            {products.map((product) => <tr key={product.id}>
              <td><div className="admin-product-cell"><img src={product.imageUrl} alt="" /><span><strong>{product.name}</strong><small>{product.brand}</small></span></div></td>
              <td>{product.category}</td><td>{price(product.price)}</td><td><span className={product.stock <= 5 ? 'stock-warning' : ''}>{product.stock}</span></td><td><span className={`status-pill ${product.published ? 'published' : 'unpublished'}`}>{product.published ? 'Published' : 'Draft'}</span></td>
              <td><div className="table-actions"><button type="button" aria-label={`Edit ${product.name}`} onClick={() => edit(product)}><Pencil size={15} /></button><button type="button" aria-label={`Delete ${product.name}`} disabled={busy} onClick={() => remove(product)}><Trash2 size={15} /></button></div></td>
            </tr>)}
          </tbody></table></div>
        )}
      </section>
    </div>
  )
}

function OrderManagement({
  orders,
  busy,
  update,
}: {
  orders: AdminOrder[]
  busy: boolean
  update: (order: AdminOrder, status: OrderStatus, paymentStatus?: PaymentStatus) => void
}) {
  const activeOrders = useMemo(() => orders.filter((order) => order.status !== 'cancelled'), [orders])
  return (
    <div className="admin-page-content">
      <section className="admin-card order-management-card">
        <div className="admin-card-heading"><div><p className="admin-caption">CASH ON DELIVERY · LATEST 50 LOADED</p><h3>Order requests <span className="admin-count">{orders.length}</span></h3></div><span className="admin-order-note"><Clock3 size={15} /> {activeOrders.filter((order) => order.status === 'pending').length} pending in this sample</span></div>
        <p className="admin-empty">Requests are unverified. Check current prices, delivery details, and availability manually before confirming. Stock is not reserved, decremented, or restored automatically.</p>
        {orders.length === 0 ? <p className="admin-empty">No orders have been placed yet.</p> : (
          <div className="admin-table-scroll"><table className="admin-table"><thead><tr><th>Order</th><th>Customer</th><th>Date</th><th>Total</th><th>Payment</th><th>Order status</th></tr></thead><tbody>
            {orders.map((order) => <tr key={order.id}>
              <td>
                <strong>{order.orderNumber}</strong>
                <small className="table-secondary">
                  {order.itemsCompleteness === 'legacy'
                    ? `${order.items.length} legacy inline items`
                    : `${order.items.length} / ${order.itemCount ?? '?'} items${order.itemsCompleteness === 'incomplete' ? ' · INCOMPLETE' : ''}`}
                </small>
              </td>
              <td><strong>{order.customer?.fullName ?? 'Customer'}</strong><small className="table-secondary">{order.customerEmail}</small></td>
              <td>{dateLabel(order.createdAt)}</td>
              <td>{order.itemsCompleteness === 'incomplete' ? 'Unverified' : price(order.total)}</td>
              <td><span className={`status-pill ${order.paymentStatus === 'paid' ? 'published' : 'unpublished'}`}>{order.paymentStatus === 'paid' ? 'Paid' : 'COD · Pending'}</span></td>
              <td><OrderStatusControl order={order} busy={busy} update={update} /></td>
            </tr>)}
          </tbody></table></div>
        )}
      </section>
      {orders.length > 0 && <OrderDetailsList orders={orders} />}
    </div>
  )
}

function OrderStatusControl({
  order,
  busy,
  update,
}: {
  order: AdminOrder
  busy: boolean
  update: (order: AdminOrder, status: OrderStatus, paymentStatus?: PaymentStatus) => void
}) {
  const options = [
    order.status,
    ...allowedOrderTransitions[order.status].filter(
      (status) => status !== 'cancelled' || order.paymentStatus !== 'paid',
    ),
  ]
  const handleStatus = (status: OrderStatus) => {
    if (order.itemsCompleteness === 'incomplete') return
    if (status === 'cancelled' && !window.confirm(`Cancel ${order.orderNumber}? Stock will not be restored automatically.`)) return
    update(order, status)
  }
  return (
    <div className="order-status-controls">
      <select aria-label={`Order status for ${order.orderNumber}`} value={order.status} disabled={busy || order.itemsCompleteness === 'incomplete' || order.status === 'cancelled' || order.status === 'delivered'} onChange={(event) => handleStatus(event.target.value as OrderStatus)}>
        {options.map((status) => <option key={status} value={status}>{status}</option>)}
      </select>
      {order.itemsCompleteness === 'incomplete' && <small className="table-secondary">Review incomplete items before changing status.</small>}
      {order.itemsCompleteness !== 'incomplete' && order.status === 'delivered' && order.paymentStatus === 'pending' && (
        <button type="button" disabled={busy} onClick={() => update(order, order.status, 'paid')}>Mark paid</button>
      )}
    </div>
  )
}

function OrderDetailsList({ orders }: { orders: AdminOrder[] }) {
  return (
    <section className="admin-card order-detail-list">
      <div className="admin-card-heading"><div><p className="admin-caption">LATEST 10 OF UP TO 50 LOADED</p><h3>Order details</h3></div></div>
      <div className="order-detail-grid">
        {orders.slice(0, 10).map((order) => (
          <details key={order.id}>
            <summary><span><strong>{order.orderNumber}</strong><small>{order.customer?.fullName ?? 'Customer'}</small></span><span>{order.status}<ArrowRight size={14} /></span></summary>
            <div className="order-detail-body">
              <p>{order.customer?.address}, {order.customer?.city}</p>
              <p>{order.customer?.phone}</p>
              {order.itemsCompleteness === 'legacy' && <p className="admin-empty">Legacy order: item lines were stored inline.</p>}
              {order.items.map((item) => <div key={item.id}><span>{item.name} × {item.quantity}</span><strong>{price(item.lineTotal)}</strong></div>)}
              {order.itemsCompleteness === 'incomplete' ? (
                <p className="admin-empty">Item records are incomplete ({order.items.length} of {order.itemCount ?? 'unknown'} expected). The submitted order total is withheld pending manual review.</p>
              ) : (
                <div className="order-detail-total"><span>Total incl. delivery · unverified request</span><strong>{price(order.total)}</strong></div>
              )}
            </div>
          </details>
        ))}
      </div>
    </section>
  )
}

function CustomerManagement({ customers }: { customers: AdminCustomer[] }) {
  return (
    <section className="admin-card customer-management">
      <div className="admin-card-heading"><div><p className="admin-caption">LATEST 100 LOADED</p><h3>Customers <span className="admin-count">{customers.length}</span></h3></div><p className="admin-privacy-note">Customer data is visible only to verified administrators.</p></div>
      {customers.length === 0 ? <p className="admin-empty">Registered customers will appear here.</p> : (
        <div className="admin-table-scroll"><table className="admin-table"><thead><tr><th>Customer</th><th>Email</th><th>Joined</th></tr></thead><tbody>
          {customers.map((customer) => <tr key={customer.id}><td><strong>{customer.displayName || 'KK customer'}</strong></td><td>{customer.email}</td><td>{customer.createdAt ? dateLabel(customer.createdAt) : 'Recently'}</td></tr>)}
        </tbody></table></div>
      )}
    </section>
  )
}

function OrderTable({ orders, compact }: { orders: AdminOrder[]; compact?: boolean }) {
  return (
    <div className="admin-table-scroll"><table className="admin-table"><thead><tr><th>Order</th><th>Customer</th><th>Date</th><th>Total</th><th>Status</th>{!compact && <th>Payment</th>}</tr></thead><tbody>
      {orders.map((order) => <tr key={order.id}><td><strong>{order.orderNumber}</strong>{order.itemsCompleteness === 'incomplete' && <small className="table-secondary">Incomplete items</small>}</td><td>{order.customer?.fullName ?? 'Customer'}</td><td>{dateLabel(order.createdAt)}</td><td>{order.itemsCompleteness === 'incomplete' ? 'Unverified' : price(order.total)}</td><td><span className={`status-pill status-${order.status}`}>{order.status}</span></td>{!compact && <td>{order.paymentStatus}</td>}</tr>)}
    </tbody></table></div>
  )
}

export default AdminApp
