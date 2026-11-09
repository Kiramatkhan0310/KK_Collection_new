import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import {
  ArrowDown,
  ArrowRight,
  ArrowUpDown,
  Check,
  ChevronDown,
  CircleAlert,
  Heart,
  Menu,
  Moon,
  Minus,
  Plus,
  Search,
  ShoppingBag,
  Sparkles,
  Sun,
  Trash2,
  X,
} from 'lucide-react'
import {
  createUserWithEmailAndPassword,
  GoogleAuthProvider,
  browserLocalPersistence,
  onAuthStateChanged,
  setPersistence,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signInWithPopup,
  signOut,
  updateProfile,
  type User,
} from 'firebase/auth'
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  query,
  runTransaction,
  serverTimestamp,
  setDoc,
  where,
  writeBatch,
} from 'firebase/firestore'
import { auth, db, isFirebaseConfigured } from './lib/firebase'
import { demoProducts, editorialImages } from './lib/demoProducts'
import { fallbackImage, handleImageError } from './lib/imageFallback'
import type { Product } from './types'
import './App.css'

type Cart = Record<string, number>
type Theme = 'light' | 'dark'
type AuthMode = 'login' | 'register' | 'reset'
type OrderResponse = {
  orderNumber: string
  subtotal: number
  deliveryFee: number
  total: number
}
type CustomerOrderItem = {
  id: string
  productId: string
  name: string
  quantity: number
  unitPrice: number
  lineTotal: number
}
type CustomerOrder = {
  id: string
  orderNumber: string
  userId: string
  customerEmail: string
  createdAt?: { toDate: () => Date }
  status: string
  paymentMethod: string
  paymentStatus: string
  total: number
  itemCount?: number
  items?: Omit<CustomerOrderItem, 'id'>[]
}
type CustomerOrderItemsState =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; items: CustomerOrderItem[]; complete: boolean; legacy: boolean }

const CART_STORAGE_KEY = 'kk-collection-cart-v1'
const THEME_STORAGE_KEY = 'kk-collection-theme-v1'
const CART_STORAGE_ERROR_EVENT = 'kk-collection-cart-storage-error'
const currentYear = new Date().getFullYear()
const MAX_ORDER_ITEMS = 20
const MAX_ITEM_QUANTITY = 20
function readCart(): Cart {
  try {
    const saved = localStorage.getItem(CART_STORAGE_KEY)
    if (!saved) return {}
    const parsed: unknown = JSON.parse(saved)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const cart: Cart = {}
    for (const [id, quantity] of Object.entries(parsed)) {
      if (
        id.length > 0 &&
        typeof quantity === 'number' &&
        Number.isInteger(quantity) &&
        quantity > 0 &&
        quantity < 100
      ) {
        cart[id] = quantity
      }
    }
    return cart
  } catch (error) {
    console.error('Unable to read the saved shopping bag.', error)
    return {}
  }
}

function readTheme(): Theme {
  try {
    return localStorage.getItem(THEME_STORAGE_KEY) === 'dark' ? 'dark' : 'light'
  } catch (error) {
    console.error('Unable to read the saved storefront theme.', error)
    return 'light'
  }
}

function formatPrice(price: number) {
  return new Intl.NumberFormat('en-PK', {
    style: 'currency',
    currency: 'PKR',
    maximumFractionDigits: 0,
  }).format(price)
}

function productCreatedTime(product: Product) {
  return product.createdAt?.toDate ? product.createdAt.toDate().getTime() : 0
}

function makeOrderNumber(id: string) {
  const date = new Date().toISOString().slice(0, 10).replaceAll('-', '')
  return `KK-${date}-${id.slice(0, 8).toUpperCase()}`
}

function formatOrderDate(value: CustomerOrder['createdAt']) {
  const date = value?.toDate()
  return date && !Number.isNaN(date.getTime())
    ? new Intl.DateTimeFormat('en-PK', { dateStyle: 'medium' }).format(date)
    : 'Date unavailable'
}

async function ensureCustomerProfile(customer: User, displayName = customer.displayName ?? '') {
  if (!db) throw new Error('Firestore is not configured.')
  if (!customer.email) throw new Error('The signed-in account does not have an email address.')
  const profileRef = doc(db, 'users', customer.uid)
  await runTransaction(db, async (transaction) => {
    const profile = await transaction.get(profileRef)
    if (profile.exists()) return
    transaction.set(profileRef, {
      email: customer.email,
      displayName: displayName.slice(0, 100),
      createdAt: serverTimestamp(),
    })
  })
}

function App() {
  const [products, setProducts] = useState<Product[]>(() =>
    isFirebaseConfigured ? [] : demoProducts,
  )
  const [wishlistIds, setWishlistIds] = useState<Set<string>>(new Set())
  const [catalogStatus, setCatalogStatus] = useState<'loading' | 'ready' | 'error'>(
    isFirebaseConfigured ? 'loading' : 'ready',
  )
  const [catalogError, setCatalogError] = useState('')
  const [user, setUser] = useState<User | null>(null)
  const [theme, setTheme] = useState<Theme>(readTheme)
  const [cart, setCart] = useState<Cart>(readCart)
  const cartRef = useRef(cart)
  const [searchText, setSearchText] = useState('')
  const [selectedCategory, setSelectedCategory] = useState('All')
  const [sortOrder, setSortOrder] = useState('featured')
  const [priceRange, setPriceRange] = useState('all')
  const [showCart, setShowCart] = useState(false)
  const [showAuth, setShowAuth] = useState(false)
  const [authMode, setAuthMode] = useState<AuthMode>('login')
  const [showCheckout, setShowCheckout] = useState(false)
  const [showOrderHistory, setShowOrderHistory] = useState(false)
  const [customerOrders, setCustomerOrders] = useState<CustomerOrder[]>([])
  const [orderHistoryStatus, setOrderHistoryStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const [expandedOrderId, setExpandedOrderId] = useState<string | null>(null)
  const [orderItemsById, setOrderItemsById] = useState<Record<string, CustomerOrderItemsState>>({})
  const [orderSuccess, setOrderSuccess] = useState<OrderResponse | null>(null)
  const [selectedProduct, setSelectedProduct] = useState<Product | null>(null)
  const [showMobileMenu, setShowMobileMenu] = useState(false)
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const previousDialogFocus = useRef<HTMLElement | null>(null)
  const orderSubmitting = useRef(false)
  const wishlistMutations = useRef(new Set<string>())

  useEffect(() => {
    if (!auth) return
    void setPersistence(auth, browserLocalPersistence).catch((error: unknown) => {
      console.error('Unable to persist the Firebase sign-in session.', error)
      setNotice('Your sign-in may not remain active after closing the browser.')
    })
    return onAuthStateChanged(auth, (currentUser) => {
      setUser(currentUser)
      setWishlistIds(new Set())
      setShowOrderHistory(false)
      setCustomerOrders([])
      setOrderHistoryStatus('idle')
      setExpandedOrderId(null)
      setOrderItemsById({})
    })
  }, [])

  useEffect(() => {
    if (!user || !db) return
    return onSnapshot(
      collection(db, 'wishlists', user.uid, 'items'),
      (snapshot) => setWishlistIds(new Set(snapshot.docs.map((item) => item.id))),
      (error) => {
        console.error('Unable to load this wishlist.', error)
        setNotice('We could not load your wishlist. Please try again later.')
      },
    )
  }, [user])

  useEffect(() => {
    if (!isFirebaseConfigured || !db) return

    const firestore = db
    let active = true
    const unsubscribe = onSnapshot(
      query(collection(firestore, 'products'), where('published', '==', true)),
      (snapshot) => {
        if (!active) return
        const loadedProducts = snapshot.docs.map((product) => ({
          id: product.id,
          ...product.data(),
        })) as Product[]
        setProducts(loadedProducts)
        setCatalogStatus('ready')
        setCatalogError('')
        if (snapshot.metadata.fromCache) return
        const productById = new Map(loadedProducts.map((product) => [product.id, product]))
        const nextCart: Cart = {}
        let removedUnavailableItem = false
        let adjustedQuantity = false
        for (const [productId, quantity] of Object.entries(cartRef.current)) {
          const product = productById.get(productId)
          if (!product || product.stock < 1) {
            removedUnavailableItem = true
            continue
          }
          nextCart[productId] = Math.min(quantity, product.stock)
          if (quantity > product.stock) adjustedQuantity = true
        }
        if (removedUnavailableItem || adjustedQuantity) {
          setCart(nextCart)
          setNotice(
            removedUnavailableItem
              ? 'Unavailable items were removed from your saved bag.'
              : 'Your bag quantities were updated to match current stock.',
          )
        }
      },
      (error) => {
        if (!active) return
        console.error('Unable to load the Firestore product catalogue.', error)
        setCatalogStatus('error')
        setCatalogError(
          'We could not load products right now. Check your connection and Firebase configuration, then try again.',
        )
      },
    )
    return () => {
      active = false
      unsubscribe()
    }
  }, [])

  useEffect(() => {
    try {
      cartRef.current = cart
      localStorage.setItem(CART_STORAGE_KEY, JSON.stringify(cart))
    } catch (error) {
      console.error('Unable to save the shopping bag in this browser.', error)
      window.dispatchEvent(new Event(CART_STORAGE_ERROR_EVENT))
    }
  }, [cart])

  useEffect(() => {
    const showStorageError = () =>
      setNotice('Your browser could not save the shopping bag. Keep this tab open while shopping.')
    window.addEventListener(CART_STORAGE_ERROR_EVENT, showStorageError)
    return () => window.removeEventListener(CART_STORAGE_ERROR_EVENT, showStorageError)
  }, [])

  useEffect(() => {
    const dialog = document.querySelector<HTMLElement>('[aria-modal="true"]')
    if (!dialog) {
      previousDialogFocus.current?.focus()
      previousDialogFocus.current = null
      return
    }
    const activeDialog = dialog

    const focusableSelector =
      'button:not([disabled]), a[href], input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
    const focusableElements = Array.from(
      activeDialog.querySelectorAll<HTMLElement>(focusableSelector),
    )
    const activeElement = document.activeElement
    if (
      !previousDialogFocus.current &&
      activeElement instanceof HTMLElement &&
      !activeDialog.contains(activeElement)
    ) {
      previousDialogFocus.current = activeElement
    }
    focusableElements[0]?.focus()

    function handleDialogKeys(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        if (orderSuccess) setOrderSuccess(null)
        else if (showOrderHistory) setShowOrderHistory(false)
        else if (selectedProduct) setSelectedProduct(null)
        else if (showCheckout) setShowCheckout(false)
        else if (showAuth) setShowAuth(false)
        else if (showCart) setShowCart(false)
        return
      }
      if (event.key !== 'Tab' || focusableElements.length === 0) return
      const first = focusableElements[0]
      const last = focusableElements[focusableElements.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      } else if (!activeDialog.contains(document.activeElement)) {
        event.preventDefault()
        first.focus()
      }
    }

    document.addEventListener('keydown', handleDialogKeys)
    return () => document.removeEventListener('keydown', handleDialogKeys)
  }, [showCart, showAuth, showCheckout, showOrderHistory, selectedProduct, orderSuccess])
  const categories = useMemo(
    () => ['All', ...new Set(products.map((product) => product.category))],
    [products],
  )
  const visibleProducts = useMemo(() => {
    const normalizedSearch = searchText.trim().toLowerCase()
    const filtered = products.filter((product) => {
      const matchesCategory =
        selectedCategory === 'All' || product.category === selectedCategory
      const matchesSearch =
        !normalizedSearch ||
        `${product.name} ${product.brand} ${product.category}`
          .toLowerCase()
          .includes(normalizedSearch)
      const matchesPrice =
        priceRange === 'all' ||
        (priceRange === 'under-2000' && product.price < 2000) ||
        (priceRange === '2000-4000' && product.price >= 2000 && product.price <= 4000) ||
        (priceRange === 'over-4000' && product.price > 4000)
      return matchesCategory && matchesSearch && matchesPrice
    })
    if (sortOrder === 'price-low') return filtered.sort((a, b) => a.price - b.price)
    if (sortOrder === 'price-high') return filtered.sort((a, b) => b.price - a.price)
    if (sortOrder === 'name') return filtered.sort((a, b) => a.name.localeCompare(b.name))
    if (sortOrder === 'popular') return filtered.sort((a, b) => (b.soldCount ?? 0) - (a.soldCount ?? 0))
    if (sortOrder === 'newest') return filtered.sort((a, b) => productCreatedTime(b) - productCreatedTime(a))
    return filtered.sort((a, b) => Number(b.featured) - Number(a.featured))
  }, [products, searchText, selectedCategory, sortOrder, priceRange])

  const cartEntries = products.filter((product) => cart[product.id])
  const cartCount = Object.values(cart).reduce((total, quantity) => total + quantity, 0)
  const subtotal = cartEntries.reduce(
    (total, product) => total + product.price * cart[product.id],
    0,
  )

  function addToCart(product: Product) {
    if (
      !product.id ||
      typeof product.name !== 'string' ||
      product.name.trim().length < 1 ||
      product.name.length > 120 ||
      !Number.isInteger(product.stock) ||
      product.stock < 1 ||
      !Number.isFinite(product.price) ||
      product.price < 0 ||
      product.price > 100000000
    ) {
      setNotice('This product is not currently available in the displayed catalogue.')
      return
    }
    setCart((current) => ({
      ...current,
      [product.id]: Math.min(
        (current[product.id] ?? 0) + 1,
        product.stock,
        MAX_ITEM_QUANTITY,
      ),
    }))
    setNotice(
      (cart[product.id] ?? 0) >= Math.min(product.stock, MAX_ITEM_QUANTITY)
        ? `${product.name} is already at the maximum request quantity.`
        : `${product.name} added to your bag`,
    )
    setShowCart(true)
    window.setTimeout(() => setNotice(''), 2800)
  }

  function updateQuantity(product: Product, quantity: number) {
    setCart((current) => {
      if (!Number.isInteger(quantity) || quantity <= 0) {
        const next = { ...current }
        delete next[product.id]
        return next
      }
      if (!Number.isInteger(product.stock) || product.stock < 1) return current
      return {
        ...current,
        [product.id]: Math.min(quantity, product.stock, MAX_ITEM_QUANTITY),
      }
    })
  }

  async function submitAuth(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!auth) {
      setNotice('Firebase Authentication is not configured yet.')
      return
    }
    const formData = new FormData(event.currentTarget)
    const email = String(formData.get('email') ?? '').trim()
    const password = String(formData.get('password') ?? '')
    const name = String(formData.get('name') ?? '').trim()
    setBusy(true)
    try {
      if (authMode === 'reset') {
        await sendPasswordResetEmail(auth, email)
        setNotice('Password reset instructions have been sent to your email.')
        setShowAuth(false)
        return
      }
      if (authMode === 'register') {
        const credential = await createUserWithEmailAndPassword(auth, email, password)
        let displayNameWarning = ''
        try {
          await updateProfile(credential.user, { displayName: name })
        } catch (profileError) {
          console.error('The account was created, but its Authentication display name could not be updated.', profileError)
          displayNameWarning = 'Your account is ready, but its display name could not be updated.'
        }
        try {
          await ensureCustomerProfile(credential.user, name)
        } catch (profileError) {
          console.error('The account was created, but its Firestore profile could not be saved.', profileError)
          setShowAuth(false)
          setNotice(`Your account was created, but its customer profile could not be set up. ${profileSetupErrorMessage(profileError)}`)
          return
        }
        setNotice(displayNameWarning || 'Your account is ready. Welcome to KK Collection!')
      } else {
        const credential = await signInWithEmailAndPassword(auth, email, password)
        try {
          await ensureCustomerProfile(credential.user)
        } catch (profileError) {
          console.error('Sign-in succeeded, but the Firestore customer profile could not be ensured.', profileError)
          setShowAuth(false)
          setNotice(profileSetupErrorMessage(profileError))
          return
        }
        setNotice('You are signed in.')
      }
      setShowAuth(false)
    } catch (error) {
      console.error('Authentication request failed.', error)
      setNotice(authErrorMessage(error))
    } finally {
      setBusy(false)
    }
  }

  async function openOrderHistory() {
    if (!user) {
      setShowAuth(true)
      return
    }
    if (!db) {
      setNotice('Order history is unavailable because Firestore is not configured.')
      return
    }

    const uid = user.uid
    setShowOrderHistory(true)
    setCustomerOrders([])
    setOrderItemsById({})
    setExpandedOrderId(null)
    setOrderHistoryStatus('loading')
    try {
      const snapshot = await getDocs(
        query(collection(db, 'orders'), where('userId', '==', uid)),
      )
      if (auth?.currentUser?.uid !== uid) return
      const loadedOrders = snapshot.docs
        .map((orderDoc) => ({
          id: orderDoc.id,
          ...orderDoc.data(),
        }) as CustomerOrder)
        .filter((order) => order.userId === uid)
        .sort((left, right) =>
          (right.createdAt?.toDate().getTime() ?? 0) -
          (left.createdAt?.toDate().getTime() ?? 0),
        )
      setCustomerOrders(loadedOrders)
      setOrderHistoryStatus('ready')
    } catch (error) {
      console.error('Unable to load customer orders.', error)
      if (auth?.currentUser?.uid === uid) setOrderHistoryStatus('error')
    }
  }

  async function loadCustomerOrderItems(order: CustomerOrder) {
    if (!db || !user || orderItemsById[order.id]?.status === 'loading') return

    const uid = user.uid
    setOrderItemsById((current) => ({ ...current, [order.id]: { status: 'loading' } }))
    try {
      const rawItems: unknown[] = Array.isArray(order.items)
        ? order.items
        : (await getDocs(collection(db, 'orders', order.id, 'items'))).docs.map(
            (itemDoc) => ({ id: itemDoc.id, ...itemDoc.data() }),
          )
      if (auth?.currentUser?.uid !== uid) return

      const items = rawItems.flatMap((rawItem, index) => {
        if (!rawItem || typeof rawItem !== 'object') return []
        const data = rawItem as Record<string, unknown>
        if (
          typeof data.productId !== 'string' ||
          data.productId.length < 1 ||
          data.productId.length > 128 ||
          typeof data.name !== 'string' ||
          data.name.length < 1 ||
          data.name.length > 120 ||
          typeof data.quantity !== 'number' ||
          !Number.isInteger(data.quantity) ||
          data.quantity < 1 ||
          data.quantity > MAX_ITEM_QUANTITY ||
          typeof data.unitPrice !== 'number' ||
          !Number.isFinite(data.unitPrice) ||
          data.unitPrice < 0 ||
          data.unitPrice > 100000000 ||
          typeof data.lineTotal !== 'number' ||
          !Number.isFinite(data.lineTotal) ||
          data.lineTotal < 0 ||
          data.lineTotal > 100000000
        ) {
          return []
        }
        return [{
          id: typeof data.id === 'string' ? data.id : `${data.productId}-${index}`,
          productId: data.productId,
          name: data.name,
          quantity: data.quantity,
          unitPrice: data.unitPrice,
          lineTotal: data.lineTotal,
        }]
      })
      const legacy = Array.isArray(order.items)
      const complete =
        items.length === rawItems.length &&
        items.length > 0 &&
        (legacy || (
          Number.isInteger(order.itemCount) &&
          (order.itemCount ?? 0) > 0 &&
          items.length === order.itemCount
        ))
      setOrderItemsById((current) => ({
        ...current,
        [order.id]: { status: 'ready', items, complete, legacy },
      }))
    } catch (error) {
      console.error(`Unable to load items for order ${order.id}.`, error)
      if (auth?.currentUser?.uid === uid) {
        setOrderItemsById((current) => ({
          ...current,
          [order.id]: { status: 'error' },
        }))
      }
    }
  }

  function toggleOrderDetails(order: CustomerOrder) {
    if (expandedOrderId === order.id) {
      setExpandedOrderId(null)
      return
    }
    setExpandedOrderId(order.id)
    if (!orderItemsById[order.id]) void loadCustomerOrderItems(order)
  }

  async function placeOrder(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (orderSubmitting.current) return
    if (!user) {
      setShowCheckout(false)
      setShowAuth(true)
      setAuthMode('login')
      setNotice('Please sign in before placing your order.')
      return
    }
    if (!db) {
      setNotice('Firestore is not configured. Please contact the store administrator.')
      return
    }
    if (!user.email) {
      setNotice('Your signed-in account needs an email address before an order request can be submitted.')
      return
    }
    const formData = new FormData(event.currentTarget)
    const customer = {
      fullName: String(formData.get('fullName') ?? '').trim(),
      phone: String(formData.get('phone') ?? '').trim(),
      address: String(formData.get('address') ?? '').trim(),
      city: String(formData.get('city') ?? '').trim(),
    }
    if (
      customer.fullName.length < 2 ||
      customer.fullName.length > 100 ||
      customer.address.length < 5 ||
      customer.address.length > 300 ||
      customer.city.length < 2 ||
      customer.city.length > 100 ||
      !/^\+?[0-9()\s.-]{7,24}$/.test(customer.phone)
    ) {
      setNotice('Check the delivery details: name and city need at least 2 characters, address 5, and phone must be valid.')
      return
    }
    if (cartEntries.length === 0) {
      setNotice('Your bag is empty. Add a few products before placing the order.')
      return
    }
    if (
      cartEntries.length > MAX_ORDER_ITEMS ||
      cartEntries.some(
        (product) =>
          !product.id ||
          product.name.trim().length < 1 ||
          product.name.length > 120 ||
          !Number.isInteger(cart[product.id]) ||
          cart[product.id] < 1 ||
          cart[product.id] > MAX_ITEM_QUANTITY ||
          !Number.isFinite(product.price) ||
          product.price < 0 ||
          product.price > 100000000 ||
          !Number.isInteger(product.stock) ||
          product.stock < cart[product.id],
      )
    ) {
      setNotice('Some bag items are no longer available or outside the supported request limits. Review the catalogue and adjust your bag.')
      return
    }
    if (
      !Number.isFinite(subtotal) ||
      subtotal < 0 ||
      subtotal > 100000000
    ) {
      setNotice('The displayed items subtotal is outside the supported request range. Review the products in your bag.')
      return
    }
    const deliveryFee = subtotal >= 5000 ? 0 : 250
    const estimatedTotal = subtotal + deliveryFee
    orderSubmitting.current = true
    setBusy(true)
    try {
      const items = cartEntries.map((product) => ({
        productId: product.id,
        name: product.name,
        quantity: cart[product.id],
        unitPrice: product.price,
        lineTotal: product.price * cart[product.id],
      }))
      const orderRef = doc(collection(db, 'orders'))
      const orderNumber = makeOrderNumber(orderRef.id)
      const orderPayload = {
        orderNumber,
        userId: user.uid,
        customerEmail: user.email ?? '',
        customer,
        subtotal,
        deliveryFee,
        total: estimatedTotal,
        paymentMethod: 'cod',
        paymentStatus: 'pending',
        status: 'pending',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
        itemCount: items.length,
      }
      const batch = writeBatch(db)
      batch.set(orderRef, orderPayload)
      for (const item of items) {
        batch.set(doc(collection(orderRef, 'items')), item)
      }
      await batch.commit()
      setCart({})
      setShowCheckout(false)
      setShowCart(false)
      setOrderSuccess({
        orderNumber,
        subtotal,
        deliveryFee,
        total: estimatedTotal,
      })
      setNotice('')
    } catch (error) {
      console.error('The order could not be placed.', error)
      setNotice(orderErrorMessage(error))
    } finally {
      orderSubmitting.current = false
      setBusy(false)
    }
  }

  async function logout() {
    if (!auth) return
    try {
      await signOut(auth)
      setNotice('You have been signed out.')
    } catch (error) {
      console.error('Sign out failed.', error)
      setNotice('We could not sign you out. Please try again.')
    }
  }

  function toggleTheme() {
    const nextTheme = theme === 'dark' ? 'light' : 'dark'
    setTheme(nextTheme)
    try {
      localStorage.setItem(THEME_STORAGE_KEY, nextTheme)
    } catch (error) {
      console.error('Unable to save the storefront theme.', error)
      setNotice('Your theme changed, but this browser could not save the preference.')
    }
  }

  async function toggleWishlist(product: Product) {
    if (!user) {
      setAuthMode('login')
      setShowAuth(true)
      setNotice('Sign in to save products to your wishlist.')
      return
    }
    if (!db) {
      setNotice('Wishlist service is not configured.')
      return
    }
    const itemRef = doc(db, 'wishlists', user.uid, 'items', product.id)
    if (wishlistMutations.current.has(product.id)) return
    wishlistMutations.current.add(product.id)
    try {
      if (wishlistIds.has(product.id)) {
        await deleteDoc(itemRef)
        setNotice(`${product.name} removed from your wishlist.`)
      } else {
        const existingItem = await getDoc(itemRef)
        if (existingItem.exists()) {
          setNotice(`${product.name} is already in your wishlist.`)
        } else {
          await setDoc(itemRef, { productId: product.id, createdAt: serverTimestamp() })
          setNotice(`${product.name} saved to your wishlist.`)
        }
      }
    } catch (error) {
      console.error('Unable to update the wishlist.', error)
      const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
      setNotice(
        code.includes('permission-denied')
          ? 'Firestore rules did not allow this wishlist change. Check your sign-in and try again.'
          : code.includes('unavailable') || code.includes('network')
            ? 'The wishlist service could not be reached. Check your connection and try again.'
            : 'We could not update your wishlist. Please try again.',
      )
    } finally {
      wishlistMutations.current.delete(product.id)
    }
  }

  async function saveNewsletterEmailLocally(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = event.currentTarget
    const email = String(new FormData(form).get('email') ?? '')
      .trim()
      .toLowerCase()
    if (!email || !email.includes('@')) {
      setNotice('Add a valid email address to subscribe.')
      return
    }
    setBusy(true)
    try {
      const newsletterStorageKey = 'kk-collection-newsletter-v1'
      const existing = JSON.parse(localStorage.getItem(newsletterStorageKey) ?? '[]') as string[]
      if (existing.includes(email)) {
        setNotice('This email is already saved in this browser. It is not on a shared mailing list.')
        return
      }
      const nextSubscribers = [...existing, email]
      localStorage.setItem(newsletterStorageKey, JSON.stringify(nextSubscribers))
      setNotice('Saved in this browser only. Your email was not sent to KK.')
      form.reset()
    } catch (error) {
      console.error('Newsletter subscription failed locally.', error)
      setNotice('We could not save your subscription in this browser. Please try again.')
    } finally {
      setBusy(false)
    }
  }

  async function signInWithGoogle() {
    if (!auth) {
      setNotice('Firebase Authentication is not configured yet.')
      return
    }
    setBusy(true)
    try {
      const credential = await signInWithPopup(auth, new GoogleAuthProvider())
      try {
        await ensureCustomerProfile(credential.user)
      } catch (profileError) {
        console.error('Google sign-in succeeded, but the Firestore profile could not be saved.', profileError)
        setShowAuth(false)
        setNotice(profileSetupErrorMessage(profileError))
        return
      }
      setShowAuth(false)
      setNotice('You are signed in.')
    } catch (error) {
      console.error('Google sign-in failed.', error)
      setNotice(authErrorMessage(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="storefront min-h-screen" data-theme={theme}>
      <div className="announcement">
        <span>COMPLIMENTARY EXPRESS DELIVERY NATIONWIDE ON ORDERS OVER RS. 5,000</span>
        <span className="announcement-divider">·</span>
        <span>Use code <strong>WELCOME10</strong> for 10% off</span>
      </div>

      <header className="site-header">
        <button
          className="icon-button mobile-menu-button"
          type="button"
          aria-label={showMobileMenu ? 'Close navigation menu' : 'Open navigation menu'}
          aria-expanded={showMobileMenu}
          onClick={() => setShowMobileMenu((open) => !open)}
        >
          {showMobileMenu ? <X /> : <Menu />}
        </button>
        <a className="brand" href="#" aria-label="KK Collection home">
          <span className="brand-seal">KK</span>
          <span className="brand-copy"><strong>KK COLLECTION</strong><small>LUXURY COSMETICS &amp; SKINCARE</small></span>
        </a>
        <nav className={`main-nav ${showMobileMenu ? 'is-open' : ''}`} aria-label="Main navigation">
          <a href="#shop" onClick={() => setShowMobileMenu(false)}>Shop all products</a>
          <a href="#about" onClick={() => setShowMobileMenu(false)}>Our story</a>
          <button
            className="main-nav-button"
            type="button"
            onClick={() => {
              setShowMobileMenu(false)
              if (user) {
                void logout()
              } else {
                setAuthMode('login')
                setShowAuth(true)
              }
            }}
          >
            {user ? 'Sign out' : 'Sign in'}
          </button>
          <a className="main-nav-button" href="/admin" onClick={() => setShowMobileMenu(false)}>
            Admin
          </a>
          {user && (
            <button
              className="main-nav-button"
              type="button"
              onClick={() => {
                setShowMobileMenu(false)
                void openOrderHistory()
              }}
            >
              My Orders
            </button>
          )}
        </nav>
        <div className="header-actions">
          <a className="icon-button header-search" href="#shop" aria-label="Browse and search products"><Search size={21} strokeWidth={1.7} /></a>
          <button className="icon-button header-wishlist" type="button" aria-label="Wishlist" onClick={() => user ? setNotice('Your saved favourites appear on their product cards.') : setShowAuth(true)}><Heart size={21} strokeWidth={1.7} /></button>
          <a className="admin-link" href="/admin">Admin</a>
          <button
            type="button"
            className="icon-button theme-toggle"
            aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
            title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
            onClick={toggleTheme}
          >
            {theme === 'dark' ? <Sun size={20} /> : <Moon size={20} />}
          </button>
          <button
            type="button"
            className="text-button account-button"
            onClick={() => (user ? void logout() : setShowAuth(true))}
          >
            {user ? 'Sign out' : 'Account'}
          </button>
          {user && (
            <button
              type="button"
              className="text-button account-button desktop-orders-button"
              onClick={() => void openOrderHistory()}
            >
              My Orders
            </button>
          )}
          <button
            type="button"
            className="icon-button bag-button"
            aria-label={`Open shopping bag, ${cartCount} items`}
            onClick={() => setShowCart(true)}
          >
            <ShoppingBag size={20} strokeWidth={1.6} />
            <span className="bag-count">{cartCount}</span>
          </button>
        </div>
      </header>

      <main>
        <nav className="reference-category-nav" aria-label="Shop by category">
          {['All', 'Skincare', 'Makeup', 'Fragrance', 'Haircare', 'Body Care'].map((category) => (
            <button
              type="button"
              key={category}
              className={selectedCategory === category ? 'active' : ''}
              aria-pressed={selectedCategory === category}
              onClick={() => { setSelectedCategory(category); document.getElementById('shop')?.scrollIntoView({ behavior: 'smooth' }) }}
            >
              {category === 'All' ? 'All Products' : category}
            </button>
          ))}
        </nav>

        <section className="hero" aria-labelledby="hero-title">
          <img className="hero-editorial-image" src={editorialImages.hero} alt="" onError={handleImageError} />
          <div className="hero-shade" />
          <div className="hero-copy">
            <p className="hero-kicker">THE AUTUMN / WINTER EDIT <span>·</span> KARACHI &amp; LAHORE FLAGSHIP</p>
            <h1 id="hero-title">Formulated for Radiance.<br />Crafted with <em>Discipline.</em></h1>
            <p className="hero-description">
              Discover bioactive barrier repair elixirs, micro-milled silk foundations, and concentrated extraits de parfum formulated to elevate everyday beauty into an enduring ritual.
            </p>
            <div className="hero-actions">
              <a className="hero-primary-action" href="#shop">Shop full catalog <ArrowRight size={16} aria-hidden="true" /></a>
              <button className="hero-secondary-action" type="button" onClick={() => { setSelectedCategory('Skincare'); document.getElementById('shop')?.scrollIntoView({ behavior: 'smooth' }) }}>Explore skincare</button>
            </div>
            <div className="hero-promises">
              <span><Sparkles size={16} aria-hidden="true" /> 60+ Curated Beauty Formulas</span>
              <i>·</i>
              <span>Complimentary Delivery Nationwide</span>
              <i>·</i>
              <span>Cash on Delivery Available</span>
            </div>
          </div>
        </section>

        <section className="category-section" aria-labelledby="category-title">
            <div className="section-heading">
              <div><p className="eyebrow">CURATED COLLECTIONS</p><h2 id="category-title">Iconic formulations of the house</h2><p className="collection-intro">Targeted active formulations calibrated for high performance, verified skin biocompatibility, and sensorial pleasure.</p></div>
              <a className="story-link" href="#shop">Explore the collection <ArrowRight size={15} /></a>
            </div>
            <div className="category-grid reference-collection-grid">
              {[
                { category: 'Skincare', name: 'Active Skin Elixirs & Barrier Repair', eyebrow: 'BIOACTIVE FORMULAS', description: 'Stabilized Vitamin C, Niacinamide, and multi-molecular ceramides for clinical radiance.', image: editorialImages.skincare },
                { category: 'Fragrance', name: 'Artisanal Extraits & Botanical Parfums', eyebrow: 'FINE FRAGRANCE', description: 'Turkish damask rose, amber resins, and oud in considered compositions.', image: editorialImages.fragrance },
                { category: 'Makeup', name: 'Silk Radiance Complexion & Velour Lips', eyebrow: 'STUDIO ARTISTRY', description: 'Weightless pigments and comfortable textures, made for everyday artistry.', image: editorialImages.makeup },
              ].map((item) => (
                <button className="reference-collection-card" type="button" key={item.category} onClick={() => { setSelectedCategory(item.category); document.getElementById('shop')?.scrollIntoView({ behavior: 'smooth' }) }}>
                  <img src={item.image} alt="" loading="lazy" onError={handleImageError} />
                  <span className="reference-collection-copy">
                    <small>{item.eyebrow}</small><strong>{item.name}</strong><span>{item.description}</span><b>Explore {item.category.toLowerCase()} <ArrowRight size={14} /></b>
                  </span>
                </button>
              ))}
            </div>
        </section>

        <section className="shop-section" id="shop" aria-labelledby="shop-title">
          <div className="section-heading">
            <div>
              <p className="eyebrow">{!isFirebaseConfigured ? 'PREVIEW CATALOGUE' : catalogStatus === 'ready' ? 'LIVE CATALOGUE' : catalogStatus === 'error' ? 'CATALOGUE ERROR' : 'LOADING CATALOGUE'} <span className="shop-eyebrow-divider">·</span> {products.length} PRODUCTS</p>
              <h2 id="shop-title">The complete cosmetics collection</h2>
            </div>
            <p className="section-aside">{isFirebaseConfigured ? 'Formulations selected with care.' : 'Preview catalogue · sample listings'}</p>
          </div>

          <div className="shop-toolbar">
            <div className="category-list" role="group" aria-label="Filter by category">
              {categories.map((category) => (
                <button
                  type="button"
                  key={category}
                  className={`category-chip ${selectedCategory === category ? 'active' : ''}`}
                  aria-pressed={selectedCategory === category}
                  onClick={() => setSelectedCategory(category)}
                >
                  {category}
                </button>
              ))}
            </div>
            <div className="shop-controls">
              <label className="search-field">
                <Search size={16} aria-hidden="true" />
                <span className="sr-only">Search products</span>
                <input
                  type="search"
                  placeholder="Find your favourite..."
                  value={searchText}
                  onChange={(event) => setSearchText(event.target.value)}
                />
              </label>
              <label className="sort-field">
                <span className="filter-label">Price</span>
                <span className="sr-only">Filter by price</span>
                <select value={priceRange} onChange={(event) => setPriceRange(event.target.value)}>
                  <option value="all">Any price</option>
                  <option value="under-2000">Under Rs. 2,000</option>
                  <option value="2000-4000">Rs. 2,000–4,000</option>
                  <option value="over-4000">Over Rs. 4,000</option>
                </select>
                <ChevronDown size={14} aria-hidden="true" />
              </label>
              <label className="sort-field">
                <ArrowUpDown size={14} aria-hidden="true" />
                <span className="sr-only">Sort products</span>
                <select value={sortOrder} onChange={(event) => setSortOrder(event.target.value)}>
                  <option value="featured">Featured</option>
                  <option value="popular">Popularity</option>
                  <option value="newest">New arrivals</option>
                  <option value="price-low">Price: low to high</option>
                  <option value="price-high">Price: high to low</option>
                  <option value="name">Name</option>
                </select>
                <ChevronDown size={14} aria-hidden="true" />
              </label>
            </div>
          </div>

          {catalogStatus === 'loading' && (
            <div className="catalog-state" role="status"><span className="spinner" /> Loading the collection...</div>
          )}
          {catalogStatus === 'error' && (
            <div className="catalog-state catalog-error" role="alert">
              <CircleAlert aria-hidden="true" /><div><strong>Our shelves are taking a moment.</strong><p>{catalogError}</p></div>
            </div>
          )}
          {catalogStatus === 'ready' && visibleProducts.length === 0 && (
            <div className="catalog-state empty-state">
              <span className="empty-flower">✳</span>
              <strong>{products.length ? 'No matches just yet.' : 'A fresh collection is on its way.'}</strong>
              <p>{products.length ? 'Try another search or category.' : 'Please check back soon for our curated beauty edit.'}</p>
              {products.length > 0 && (
                <button className="text-button" type="button" onClick={() => { setSearchText(''); setSelectedCategory('All'); setPriceRange('all') }}>
                  Clear filters <ArrowRight size={15} />
                </button>
              )}
            </div>
          )}
          {catalogStatus === 'ready' && visibleProducts.length > 0 && (
            <>
              <div className="product-grid">
                {visibleProducts.map((product, index) => (
                  <article className="product-card" key={product.id}>
                    <div className="product-image-wrap">
                      <img
                        src={product.imageUrl || fallbackImage}
                        alt={product.imageAlt || product.name}
                        loading={index > 3 ? 'lazy' : 'eager'}
                        onError={handleImageError}
                      />
                      {product.badge && <span className="product-badge">{product.badge}</span>}
                      <button
                        type="button"
                        aria-label={`${wishlistIds.has(product.id) ? 'Remove' : 'Add'} ${product.name} ${wishlistIds.has(product.id) ? 'from' : 'to'} wishlist`}
                        aria-pressed={wishlistIds.has(product.id)}
                        className={`wishlist-button ${wishlistIds.has(product.id) ? 'is-saved' : ''}`}
                        onClick={() => void toggleWishlist(product)}
                      >
                        <Heart size={17} aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        className="quick-add"
                        disabled={product.stock < 1 || (cart[product.id] ?? 0) >= Math.min(product.stock, MAX_ITEM_QUANTITY)}
                        onClick={() => addToCart(product)}
                      >
                        {product.stock < 1 ? 'Sold out' : (cart[product.id] ?? 0) >= product.stock ? 'Max in bag' : <>Add to bag <Plus size={15} /></>}
                      </button>
                    </div>
                    <div className="product-info">
                      <p className="product-category">{product.category}</p>
                      <h3><button className="product-title-button" type="button" onClick={() => setSelectedProduct(product)}>{product.name}</button></h3>
                      <p className="product-brand">{product.brand}</p>
                      <div className="product-price">
                        <span>{formatPrice(product.price)}</span>
                        {product.compareAtPrice > product.price && (
                          <del>{formatPrice(product.compareAtPrice)}</del>
                        )}
                        {product.stock > 0 && product.stock <= 5 && <small>{isFirebaseConfigured ? `Only ${product.stock} left` : `Demo stock: ${product.stock}`}</small>}
                      </div>
                      <button className="product-detail-link" type="button" onClick={() => setSelectedProduct(product)}>View details <ArrowRight size={13} /></button>
                    </div>
                  </article>
                ))}
              </div>
              <p className="product-count">SHOWING {visibleProducts.length} OF {products.length} PIECES</p>
            </>
          )}
        </section>

        <section className="story-banner" id="about">
          <div className="story-art">
            <div className="story-orb" />
            <div className="story-tube"><span>KK<br />COLLECTION</span></div>
            <span className="story-stamp">A MORE<br />MINDFUL<br />MOMENT</span>
          </div>
          <div className="story-copy">
            <p className="eyebrow">A NOTE FROM US</p>
            <h2>Beauty should<br />feel like <em>you.</em></h2>
            <p>We believe the best beauty routine is the one that makes you feel at home in your own skin. A thoughtful edit of everyday essentials, chosen to bring a little joy to your daily ritual.</p>
            <a href="#shop" className="story-link">Explore the collection <ArrowRight size={16} /></a>
          </div>
        </section>

        <section className="newsletter">
          <span className="newsletter-flower" aria-hidden="true">✳</span>
          <p className="eyebrow">A NOTE FROM KK</p>
          <h2>A little beauty for this demo.</h2>
          <p>Enter an address to save it only in this browser. No email will be sent.</p>
          <form className="newsletter-form" onSubmit={(event) => void saveNewsletterEmailLocally(event)}>
            <label htmlFor="newsletter-email" className="sr-only">Email address</label>
            <input id="newsletter-email" name="email" type="email" autoComplete="email" placeholder="Your email address" required maxLength={254} />
            <button type="submit" disabled={busy} aria-label="Save email in this browser"><ArrowRight size={19} /></button>
          </form>
          <small>Demo only: your address stays in this browser and is not added to a shared mailing list.</small>
        </section>
      </main>

      <footer className="site-footer">
        <div className="footer-main">
          <a className="brand footer-brand" href="#" aria-label="KK Collection home">
            <span className="brand-seal">KK</span>
            <span className="brand-copy"><strong>KK COLLECTION</strong><small>LUXURY COSMETICS &amp; SKINCARE</small></span>
          </a>
          <p className="footer-brand-note">Thoughtful beauty for everyday rituals.<br />Curated with care by KK Collection.</p>
          <div className="footer-column">
            <strong>EXPLORE</strong>
            <a href="#shop" onClick={() => setSelectedCategory('All')}>All products</a>
            <a href="#shop" onClick={() => setSelectedCategory('Skincare')}>Skincare</a>
            <a href="#shop" onClick={() => setSelectedCategory('Makeup')}>Makeup</a>
            <a href="#shop" onClick={() => setSelectedCategory('Fragrance')}>Fragrance</a>
            <a href="#about">Our story</a>
          </div>
          <div className="footer-column footer-service">
            <strong>HERE TO HELP</strong>
            <span>Complimentary delivery on orders over Rs. 5,000</span>
            <span>Cash on delivery available</span>
            <span>Store contact details will be added before launch</span>
          </div>
          <div className="footer-social"><span>FOLLOW KK</span><span className="footer-coming">Social links will be added before launch</span></div>
        </div>
        <div className="footer-legal"><span>© {currentYear} KK Collection</span><span>Beauty, thoughtfully chosen.</span><span>Privacy notice required before launch</span><a href="/admin">Admin portal</a></div>
      </footer>

      {notice && (
        <div className="toast" role="status">
          <Check size={17} aria-hidden="true" /><span>{notice}</span>
          <button type="button" aria-label="Dismiss message" onClick={() => setNotice('')}><X size={15} /></button>
        </div>
      )}

      {showCart && (
        <div className="overlay" onMouseDown={(event) => { if (event.target === event.currentTarget) setShowCart(false) }}>
          <aside className="side-panel cart-panel" aria-label="Shopping bag" aria-modal="true" role="dialog">
            <div className="panel-heading">
              <div><p className="eyebrow">YOUR EDIT</p><h2>Your bag <span>({cartCount})</span></h2></div>
              <button className="icon-button" type="button" aria-label="Close shopping bag" onClick={() => setShowCart(false)}><X /></button>
            </div>
            {cartEntries.length === 0 ? (
              <div className="cart-empty"><ShoppingBag size={31} /><strong>Your bag is taking a little break.</strong><p>Find something lovely to bring it back.</p><button className="button button-dark" type="button" onClick={() => setShowCart(false)}>Explore the collection</button></div>
            ) : (
              <>
                <div className="cart-items">
                  {cartEntries.map((product) => (
                    <div className="cart-item" key={product.id}>
                      <img src={product.imageUrl || fallbackImage} alt="" onError={handleImageError} />
                      <div className="cart-item-details"><p className="product-category">{product.category}</p><strong>{product.name}</strong><span>{formatPrice(product.price)}</span>
                        <div className="quantity-control">
                          <button type="button" aria-label={`Decrease ${product.name} quantity`} onClick={() => updateQuantity(product, cart[product.id] - 1)}><Minus size={13} /></button>
                          <span>{cart[product.id]}</span>
                          <button type="button" aria-label={`Increase ${product.name} quantity`} disabled={cart[product.id] >= Math.min(product.stock, MAX_ITEM_QUANTITY)} onClick={() => updateQuantity(product, cart[product.id] + 1)}><Plus size={13} /></button>
                        </div>
                      </div>
                      <button className="remove-button" type="button" aria-label={`Remove ${product.name}`} onClick={() => updateQuantity(product, 0)}><Trash2 size={16} /></button>
                    </div>
                  ))}
                </div>
                <div className="cart-summary">
                  <div><span>Subtotal</span><strong>{formatPrice(subtotal)}</strong></div>
                  <p>Displayed quantities and amounts are estimates; bag items are not reserved.</p>
                  <button className="button button-dark checkout-button" type="button" onClick={() => { setShowCart(false); setShowCheckout(true) }}>
                    Continue to checkout <ArrowRight size={16} />
                  </button>
                  <button className="text-button continue-shopping" type="button" onClick={() => setShowCart(false)}>Continue shopping</button>
                </div>
              </>
            )}
          </aside>
        </div>
      )}

      {showAuth && (
        <div className="overlay" onMouseDown={(event) => { if (event.target === event.currentTarget) setShowAuth(false) }}>
          <section className="dialog-card" aria-label="Account" aria-modal="true" role="dialog">
            <button className="icon-button dialog-close" type="button" aria-label="Close account dialog" onClick={() => setShowAuth(false)}><X /></button>
            <p className="eyebrow">{authMode === 'register' ? 'A GOOD PLACE TO BEGIN' : 'WELCOME BACK'}</p>
            <h2>{authMode === 'register' ? 'Create your account.' : authMode === 'reset' ? 'Reset your password.' : 'Your KK account.'}</h2>
            <p className="dialog-intro">Sign in to keep your beauty favourites close.</p>
            <form className="stacked-form" onSubmit={(event) => void submitAuth(event)}>
              {authMode === 'register' && <label>Full name<input name="name" autoComplete="name" required maxLength={100} /></label>}
              <label>Email address<input name="email" type="email" autoComplete="email" required maxLength={254} /></label>
              {authMode !== 'reset' && <label>Password<input name="password" type="password" autoComplete={authMode === 'register' ? 'new-password' : 'current-password'} required minLength={authMode === 'register' ? 8 : 1} /></label>}
              <button className="button button-dark form-submit" type="submit" disabled={busy}>{busy ? 'Please wait...' : authMode === 'register' ? 'Create account' : authMode === 'reset' ? 'Send reset link' : 'Sign in'} <ArrowRight size={16} /></button>
            </form>
            <div className="auth-switch">
              {authMode === 'login' && <><button type="button" onClick={() => setAuthMode('reset')}>Forgot password?</button><button type="button" onClick={() => setAuthMode('register')}>Create an account</button></>}
              {authMode !== 'login' && <button type="button" onClick={() => setAuthMode('login')}>Back to sign in</button>}
            </div>
            {authMode !== 'reset' && (
              <button className="google-signin" type="button" onClick={() => void signInWithGoogle()} disabled={busy}>
                Continue with Google
              </button>
            )}
          </section>
        </div>
      )}

      {showOrderHistory && (
        <div
          className="overlay"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setShowOrderHistory(false)
          }}
        >
          <section
            className="dialog-card order-history-dialog"
            aria-labelledby="order-history-title"
            aria-modal="true"
            role="dialog"
          >
            <button
              className="icon-button dialog-close"
              type="button"
              aria-label="Close My Orders"
              onClick={() => setShowOrderHistory(false)}
            >
              <X />
            </button>
            <p className="eyebrow">YOUR KK ACCOUNT</p>
            <h2 id="order-history-title">My Orders</h2>
            <p className="dialog-intro">
              Showing orders submitted by {user?.email}. COD requests, prices,
              stock, and payment details are not independently verified.
            </p>
            {orderHistoryStatus === 'loading' && (
              <p className="order-history-message" role="status">Loading your orders…</p>
            )}
            {orderHistoryStatus === 'error' && (
              <div className="order-history-message" role="alert">
                <p>We could not load your orders. Check your connection and try again.</p>
                <button className="text-button" type="button" onClick={() => void openOrderHistory()}>
                  Try again
                </button>
              </div>
            )}
            {orderHistoryStatus === 'ready' && customerOrders.length === 0 && (
              <p className="order-history-message">You have not submitted any orders yet.</p>
            )}
            {orderHistoryStatus === 'ready' && customerOrders.length > 0 && (
              <div className="customer-order-list">
                {customerOrders.map((order) => {
                  const itemState = orderItemsById[order.id]
                  const expanded = expandedOrderId === order.id
                  return (
                    <article className="customer-order-card" key={order.id}>
                      <button
                        className="customer-order-toggle"
                        type="button"
                        aria-expanded={expanded}
                        aria-controls={`order-items-${order.id}`}
                        onClick={() => toggleOrderDetails(order)}
                      >
                        <span className="customer-order-heading">
                          <strong>{order.orderNumber || 'Order request'}</strong>
                          <small>{formatOrderDate(order.createdAt)}</small>
                        </span>
                        <span className="customer-order-summary">
                          <span>{order.status || 'Status unavailable'}</span>
                          <span>{order.paymentMethod === 'cod' ? 'Cash on Delivery' : order.paymentMethod}</span>
                          <span>{order.paymentStatus || 'Payment status unavailable'}</span>
                          <strong>
                            {itemState?.status === 'ready'
                              ? itemState.complete
                                ? `${formatPrice(order.total)} · unverified`
                                : 'Incomplete · unverified'
                              : 'Expand to view total'}
                          </strong>
                          <span aria-hidden="true">{expanded ? '−' : '+'}</span>
                        </span>
                      </button>
                      {expanded && (
                        <div className="customer-order-items" id={`order-items-${order.id}`}>
                          <p className="customer-order-notice">
                            Submitted order information is unverified. Price, stock,
                            delivery, and payment require store review.
                          </p>
                          {itemState?.status === 'loading' && (
                            <p role="status">Loading order items…</p>
                          )}
                          {itemState?.status === 'error' && (
                            <div role="alert">
                              <p>Order items could not be loaded.</p>
                              <button
                                className="text-button"
                                type="button"
                                onClick={() => void loadCustomerOrderItems(order)}
                              >
                                Try again
                              </button>
                            </div>
                          )}
                          {itemState?.status === 'ready' && (
                            <>
                              {itemState.legacy && (
                                <p className="customer-order-notice">Legacy order items are shown from the original order record.</p>
                              )}
                              {itemState.items.map((item) => (
                                <div className="customer-order-item" key={item.id}>
                                  <span>{item.name} × {item.quantity}</span>
                                  <small>{formatPrice(item.unitPrice)} each</small>
                                  <strong>{formatPrice(item.lineTotal)}</strong>
                                </div>
                              ))}
                              {!itemState.complete && (
                                <p className="customer-order-incomplete" role="status">
                                  This order is incomplete or could not be fully verified from its saved item records.
                                  {order.itemCount ? ` Found ${itemState.items.length} of ${order.itemCount} expected items.` : ''}
                                  {' '}The displayed item total is not an authoritative order total.
                                </p>
                              )}
                              {itemState.complete && (
                                <div className="customer-order-total">
                                  <span>Submitted total · unverified</span>
                                  <strong>{formatPrice(order.total)}</strong>
                                </div>
                              )}
                            </>
                          )}
                        </div>
                      )}
                    </article>
                  )
                })}
              </div>
            )}
          </section>
        </div>
      )}

      {showCheckout && (
        <div className="overlay" onMouseDown={(event) => { if (event.target === event.currentTarget) setShowCheckout(false) }}>
          <section className="dialog-card checkout-dialog" aria-label="COD order request" aria-modal="true" role="dialog">
            <button className="icon-button dialog-close" type="button" aria-label="Close checkout" onClick={() => setShowCheckout(false)}><X /></button>
            <p className="eyebrow">ALMOST YOURS</p>
            <h2>Delivery details.</h2>
            <p className="dialog-intro">{user ? `Submitting a request as ${user.email}` : 'Sign in is required to submit a request.'}</p>
            <form className="stacked-form" onSubmit={(event) => void placeOrder(event)}>
              <label>Full name<input name="fullName" autoComplete="name" required maxLength={100} /></label>
              <label>Phone number<input name="phone" type="tel" autoComplete="tel" required maxLength={24} /></label>
              <label>Street address<textarea name="address" autoComplete="street-address" rows={2} required maxLength={300} /></label>
              <label>City<input name="city" autoComplete="address-level2" required maxLength={100} /></label>
              <div className="payment-note"><span>PAYMENT</span><strong>Cash on Delivery</strong><small>If the store confirms availability, payment is due on delivery. No card payment is collected online.</small></div>
              <div className="checkout-estimate">
                <div><span>Items subtotal</span><strong>{formatPrice(subtotal)}</strong></div>
                <div><span>Estimated delivery</span><strong>{subtotal >= 5000 ? 'Complimentary' : formatPrice(250)}</strong></div>
                <div className="checkout-total"><span>Estimated total</span><strong>{formatPrice(subtotal + (subtotal >= 5000 ? 0 : 250))}</strong></div>
                <small>Prices, delivery, and stock in this request are estimates. The store must verify them manually; no stock is reserved, decremented, or restored automatically. Client-side checks are for data quality, not trusted security.</small>
              </div>
              <button className="button button-dark form-submit" type="submit" disabled={busy || cartEntries.length === 0}>{busy ? 'Submitting request...' : 'Submit COD request'} <ArrowRight size={16} /></button>
            </form>
          </section>
        </div>
      )}

      {selectedProduct && (
        <div className="overlay" onMouseDown={(event) => { if (event.target === event.currentTarget) setSelectedProduct(null) }}>
          <section className="dialog-card product-dialog" aria-label={`${selectedProduct.name} details`} aria-modal="true" role="dialog">
            <button className="icon-button dialog-close" type="button" aria-label="Close product details" onClick={() => setSelectedProduct(null)}><X /></button>
            <img className="product-dialog-image" src={selectedProduct.imageUrl || fallbackImage} alt={selectedProduct.imageAlt || selectedProduct.name} onError={handleImageError} />
            <div className="product-dialog-copy">
              <p className="eyebrow">{selectedProduct.category}</p>
              <h2>{selectedProduct.name}</h2>
              <p className="product-dialog-brand">{selectedProduct.brand}</p>
              <p className="product-dialog-description">{selectedProduct.description}</p>
              <div className="product-dialog-price"><strong>{formatPrice(selectedProduct.price)}</strong>{selectedProduct.compareAtPrice > selectedProduct.price && <del>{formatPrice(selectedProduct.compareAtPrice)}</del>}</div>
              <p className="product-dialog-stock">{selectedProduct.stock > 0 ? isFirebaseConfigured ? `${selectedProduct.stock} shown in catalogue` : `Demo stock: ${selectedProduct.stock}` : isFirebaseConfigured ? 'Currently out of stock' : 'Demo item marked out of stock'}</p>
              <button
                className="button button-dark form-submit"
                type="button"
                disabled={selectedProduct.stock < 1 || (cart[selectedProduct.id] ?? 0) >= Math.min(selectedProduct.stock, MAX_ITEM_QUANTITY)}
                onClick={() => { addToCart(selectedProduct); setSelectedProduct(null) }}
              >
                {selectedProduct.stock < 1 ? 'Sold out' : (cart[selectedProduct.id] ?? 0) >= selectedProduct.stock ? 'Maximum quantity in bag' : 'Add to bag'}
                <ShoppingBag size={16} />
              </button>
            </div>
          </section>
        </div>
      )}

      {orderSuccess && (
        <div className="overlay">
          <section className="dialog-card success-dialog" aria-labelledby="order-success-title" aria-modal="true" role="dialog">
            <span className="success-icon"><Check size={24} aria-hidden="true" /></span>
            <p className="eyebrow">A LITTLE SOMETHING TO LOOK FORWARD TO</p>
            <h2 id="order-success-title">Your request is submitted.</h2>
            <p className="dialog-intro">Your pending Cash on Delivery request is unverified. An administrator must manually review its price, delivery details, and product availability. Stock is not automatically reserved, decremented, or restored. Client-side checks are for data quality, not trusted security.</p>
            <div className="success-order-number"><span>ORDER NUMBER</span><strong>{orderSuccess.orderNumber}</strong></div>
            <div className="success-order-number"><span>ESTIMATED TOTAL · NOT VERIFIED</span><strong>{formatPrice(orderSuccess.total)}</strong></div>
            <button className="button button-dark form-submit" type="button" onClick={() => setOrderSuccess(null)}>Continue exploring <ArrowRight size={16} /></button>
          </section>
        </div>
      )}

      <a className="back-to-top" href="#" aria-label="Back to top"><ArrowDown size={16} /></a>
    </div>
  )
}

function authErrorMessage(error: unknown) {
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
  if (code.includes('email-already-in-use')) return 'An account already uses that email. Try signing in instead.'
  if (code.includes('invalid-credential') || code.includes('user-not-found') || code.includes('wrong-password')) return 'That email and password combination was not recognized.'
  if (code.includes('weak-password')) return 'Choose a password with at least 8 characters.'
  if (code.includes('invalid-email')) return 'Enter a valid email address.'
  if (code.includes('too-many-requests')) return 'Too many attempts. Please wait a moment and try again.'
  if (code.includes('network-request-failed') || code.includes('unavailable')) return 'The service could not be reached. Check your connection and try again.'
  return 'We could not complete that account request. Please try again.'
}

function profileSetupErrorMessage(error: unknown) {
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
  if (code.includes('permission-denied')) {
    return 'You are signed in, but Firestore denied your customer profile request. Verify the deployed profile rule and that this app is connected to the intended Firebase project.'
  }
  if (code.includes('unavailable') || code.includes('network')) {
    return 'You are signed in, but Firestore could not be reached to create your customer profile. Check your connection and try again.'
  }
  return 'You are signed in, but we could not create your customer profile. Please try again or contact the store administrator.'
}

function orderErrorMessage(error: unknown) {
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
  if (code.includes('unauthenticated')) return 'Your sign-in expired. Sign in again; your bag is unchanged.'
  if (code.includes('permission-denied')) return 'Firestore rules rejected this request. Check that you are signed in and the request fields meet the deployed rules. Your bag is unchanged.'
  if (code.includes('unavailable') || code.includes('network') || code.includes('deadline-exceeded')) return 'Firestore could not be reached. Check your connection; your bag is unchanged.'
  if (code.includes('invalid-argument')) return 'The order request contains invalid details. Review your delivery information and bag; your bag is unchanged.'
  return 'Firestore could not save the order request. Your bag is unchanged; please try again.'
}

export default App
