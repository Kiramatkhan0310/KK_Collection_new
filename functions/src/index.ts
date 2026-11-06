import { createHash } from 'node:crypto'
import { initializeApp } from 'firebase-admin/app'
import {
  FieldValue,
  getFirestore,
  AggregateField,
  Timestamp,
  type DocumentReference,
} from 'firebase-admin/firestore'
import { setGlobalOptions } from 'firebase-functions/v2'
import { HttpsError, onCall, type CallableRequest } from 'firebase-functions/v2/https'

initializeApp()
setGlobalOptions({ region: 'us-central1', maxInstances: 10 })

const db = getFirestore()

type CustomerDetails = {
  fullName: string
  phone: string
  address: string
  city: string
}

type OrderItemRequest = {
  productId: string
  quantity: number
  expectedUnitPrice: number
}

type ProductInput = {
  name: string
  brand: string
  category: string
  description: string
  price: number
  compareAtPrice: number
  stock: number
  imageUrl: string
  imageAlt: string
  imagePath: string
  badge?: string
  featured: boolean
  published: boolean
}

const ORDER_STATUSES = [
  'pending',
  'confirmed',
  'shipped',
  'delivered',
  'cancelled',
] as const
const PAYMENT_STATUSES = ['pending', 'paid', 'cancelled'] as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requiredString(
  value: unknown,
  field: string,
  minLength: number,
  maxLength: number,
): string {
  if (
    typeof value !== 'string' ||
    value.trim().length < minLength ||
    value.trim().length > maxLength
  ) {
    throw new HttpsError('invalid-argument', `Invalid ${field}.`)
  }
  return value.trim()
}

function requireAdmin(request: CallableRequest<unknown>): string {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Sign in is required.')
  }
  if (request.auth.token.admin !== true) {
    throw new HttpsError('permission-denied', 'Administrator access is required.')
  }
  return request.auth.uid
}

function parseCustomer(value: unknown): CustomerDetails {
  if (!isRecord(value)) {
    throw new HttpsError('invalid-argument', 'Delivery details are required.')
  }
  const fullName = requiredString(value.fullName, 'full name', 2, 100)
  const phone = requiredString(value.phone, 'phone number', 7, 24)
  const address = requiredString(value.address, 'street address', 5, 300)
  const city = requiredString(value.city, 'city', 2, 100)
  if (!/^\+?[0-9()\s.-]{7,24}$/.test(phone)) {
    throw new HttpsError('invalid-argument', 'Enter a valid phone number.')
  }
  return { fullName, phone, address, city }
}

function parseOrderItems(value: unknown): OrderItemRequest[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 30) {
    throw new HttpsError('invalid-argument', 'Your bag is empty or contains too many items.')
  }
  const quantities = new Map<string, OrderItemRequest>()
  for (const rawItem of value) {
    if (!isRecord(rawItem)) {
      throw new HttpsError('invalid-argument', 'An order item is invalid.')
    }
    const productId = requiredString(rawItem.productId, 'product ID', 1, 128)
    if (!/^[A-Za-z0-9_-]+$/.test(productId)) {
      throw new HttpsError('invalid-argument', 'A product ID is invalid.')
    }
    const quantity = rawItem.quantity
    if (typeof quantity !== 'number' || !Number.isSafeInteger(quantity) || quantity < 1 || quantity > 20) {
      throw new HttpsError('invalid-argument', 'Item quantities must be between 1 and 20.')
    }
    const expectedUnitPrice = rawItem.expectedUnitPrice
    if (
      typeof expectedUnitPrice !== 'number' ||
      !Number.isFinite(expectedUnitPrice) ||
      expectedUnitPrice < 0
    ) {
      throw new HttpsError('invalid-argument', 'An item price is invalid.')
    }
    const existing = quantities.get(productId)
    if (existing && existing.expectedUnitPrice !== expectedUnitPrice) {
      throw new HttpsError('invalid-argument', 'A product has conflicting prices in your bag.')
    }
    const combinedQuantity = (existing?.quantity ?? 0) + quantity
    if (combinedQuantity > 20) {
      throw new HttpsError('invalid-argument', 'An item quantity exceeds the maximum.')
    }
    quantities.set(productId, { productId, quantity: combinedQuantity, expectedUnitPrice })
  }
  return [...quantities.values()]
}

function parseProduct(value: unknown): ProductInput {
  if (!isRecord(value)) {
    throw new HttpsError('invalid-argument', 'Product details are required.')
  }
  const name = requiredString(value.name, 'product name', 2, 120)
  const brand = requiredString(value.brand, 'brand', 1, 80)
  const category = requiredString(value.category, 'category', 1, 80)
  const description = requiredString(value.description, 'description', 1, 3000)
  const price = value.price
  const compareAtPrice = value.compareAtPrice
  const stock = value.stock
  if (
    typeof price !== 'number' ||
    !Number.isFinite(price) ||
    price < 0 ||
    price > 100000000 ||
    typeof compareAtPrice !== 'number' ||
    !Number.isFinite(compareAtPrice) ||
    compareAtPrice < price ||
    compareAtPrice > 100000000 ||
    typeof stock !== 'number' ||
    !Number.isSafeInteger(stock) ||
    stock < 0 ||
    stock > 100000
  ) {
    throw new HttpsError('invalid-argument', 'Price, original price, or stock is invalid.')
  }
  const imageUrl = requiredString(value.imageUrl, 'image URL', 1, 1500)
  const imagePath = requiredString(value.imagePath, 'image path', 1, 500)
  let parsedImageUrl: URL
  try {
    parsedImageUrl = new URL(imageUrl)
  } catch {
    throw new HttpsError('invalid-argument', 'The product image URL is invalid.')
  }
  if (
    parsedImageUrl.protocol !== 'https:' ||
    !['firebasestorage.googleapis.com', 'storage.googleapis.com'].includes(
      parsedImageUrl.hostname,
    )
  ) {
    throw new HttpsError('invalid-argument', 'Product images must be stored in Firebase Storage.')
  }
  if (!imagePath.startsWith('products/') || imagePath.includes('..')) {
    throw new HttpsError('invalid-argument', 'The product image path is invalid.')
  }
  const imageAlt = requiredString(value.imageAlt, 'image description', 2, 180)
  const badge =
    value.badge === undefined || value.badge === ''
      ? undefined
      : requiredString(value.badge, 'badge', 1, 30)
  if (typeof value.featured !== 'boolean' || typeof value.published !== 'boolean') {
    throw new HttpsError('invalid-argument', 'Product visibility settings are invalid.')
  }
  return {
    name,
    brand,
    category,
    description,
    price,
    compareAtPrice,
    stock,
    imageUrl,
    imageAlt,
    imagePath,
    ...(badge ? { badge } : {}),
    featured: value.featured,
    published: value.published,
  }
}

export const createOrder = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Sign in before placing an order.')
  }
  const customer = parseCustomer(isRecord(request.data) ? request.data.customer : undefined)
  const requestedItems = parseOrderItems(
    isRecord(request.data) ? request.data.items : undefined,
  )
  const orderRef = db.collection('orders').doc()
  const orderNumber = `KK-${new Date().toISOString().slice(0, 10).replaceAll('-', '')}-${orderRef.id.toUpperCase()}`
  const productRefs = requestedItems.map((item) =>
    db.collection('products').doc(item.productId),
  )

  const savedOrder = await db.runTransaction(async (transaction) => {
    const snapshots = await Promise.all(productRefs.map((ref) => transaction.get(ref)))
    let subtotal = 0
    const items = requestedItems.map((requested, index) => {
      const snapshot = snapshots[index]
      if (!snapshot.exists) {
        throw new HttpsError('not-found', 'One of the products in your bag is unavailable.')
      }
      const product = snapshot.data()
      if (
        !product ||
        product.published !== true ||
        typeof product.price !== 'number' ||
        !Number.isFinite(product.price) ||
        product.price < 0 ||
        product.price !== requested.expectedUnitPrice ||
        !Number.isSafeInteger(product.stock) ||
        product.stock < requested.quantity
      ) {
        throw new HttpsError(
          'failed-precondition',
          'A product price or available quantity changed. Review your bag and try again.',
        )
      }
      const lineTotal = Math.round(product.price * requested.quantity * 100) / 100
      subtotal += lineTotal
      return {
        productId: snapshot.id,
        name: requiredString(product.name, 'product name', 2, 120),
        brand: requiredString(product.brand, 'brand', 1, 80),
        unitPrice: product.price,
        quantity: requested.quantity,
        lineTotal,
      }
    })
    const deliveryFee = subtotal >= 5000 ? 0 : 250
    const total = Math.round((subtotal + deliveryFee) * 100) / 100
    const now = FieldValue.serverTimestamp()
    transaction.set(orderRef, {
      orderNumber,
      userId: request.auth!.uid,
      customerEmail: request.auth!.token.email ?? '',
      customer,
      items,
      subtotal,
      deliveryFee,
      total,
      currency: 'PKR',
      status: 'pending',
      paymentMethod: 'cod',
      paymentStatus: 'pending',
      createdAt: now,
      updatedAt: now,
    })
    snapshots.forEach((snapshot, index) => {
      const product = snapshot.data()!
      const item = requestedItems[index]
      const newStock = product.stock - item.quantity
      transaction.update(snapshot.ref, {
        stock: newStock,
        soldCount: FieldValue.increment(item.quantity),
        updatedAt: now,
      })
      transaction.set(db.collection('inventory').doc(), {
        productId: snapshot.id,
        orderId: orderRef.id,
        movementType: 'sale',
        quantity: -item.quantity,
        previousStock: product.stock,
        newStock,
        actorUid: request.auth!.uid,
        createdAt: now,
      })
    })
    return { subtotal, deliveryFee, total }
  })

  return { orderNumber, ...savedOrder }
})

export const subscribeNewsletter = onCall(async (request) => {
  const email = requiredString(
    isRecord(request.data) ? request.data.email : undefined,
    'email address',
    3,
    254,
  ).toLowerCase()
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new HttpsError('invalid-argument', 'Enter a valid email address.')
  }
  const subscriberId = createHash('sha256').update(email).digest('hex')
  await db.collection('newsletterSubscribers').doc(subscriberId).set(
    { email, status: 'active', subscribedAt: FieldValue.serverTimestamp() },
    { merge: true },
  )
  return { subscribed: true }
})

export const upsertProduct = onCall(async (request) => {
  const adminUid = requireAdmin(request)
  if (!isRecord(request.data)) {
    throw new HttpsError('invalid-argument', 'Product details are required.')
  }
  const product = parseProduct(request.data.product)
  const id =
    request.data.id === undefined
      ? undefined
      : requiredString(request.data.id, 'product ID', 1, 128)
  if (id && !/^[A-Za-z0-9_-]+$/.test(id)) {
    throw new HttpsError('invalid-argument', 'The product ID is invalid.')
  }
  const ref = id ? db.collection('products').doc(id) : db.collection('products').doc()
  await db.runTransaction(async (transaction) => {
    const current = id ? await transaction.get(ref) : null
    if (id && !current?.exists) {
      throw new HttpsError('not-found', 'That product no longer exists.')
    }
    transaction.set(
      ref,
      {
        ...product,
        ...(current?.exists ? {} : { soldCount: 0, createdAt: FieldValue.serverTimestamp() }),
        updatedAt: FieldValue.serverTimestamp(),
        updatedBy: adminUid,
      },
      { merge: true },
    )
    const previousStock = current?.get('stock')
    if (
      !current?.exists ||
      (typeof previousStock === 'number' && previousStock !== product.stock)
    ) {
      transaction.set(db.collection('inventory').doc(), {
        productId: ref.id,
        movementType: current?.exists ? 'adjustment' : 'opening_stock',
        quantity:
          typeof previousStock === 'number'
            ? product.stock - previousStock
            : product.stock,
        ...(typeof previousStock === 'number' ? { previousStock } : {}),
        newStock: product.stock,
        actorUid: adminUid,
        createdAt: FieldValue.serverTimestamp(),
      })
    }
  })
  return { id: ref.id }
})

export const deleteProduct = onCall(async (request) => {
  requireAdmin(request)
  const id = requiredString(
    isRecord(request.data) ? request.data.id : undefined,
    'product ID',
    1,
    128,
  )
  if (!/^[A-Za-z0-9_-]+$/.test(id)) {
    throw new HttpsError('invalid-argument', 'The product ID is invalid.')
  }
  const productRef = db.collection('products').doc(id)
  const product = await productRef.get()
  if (!product.exists) {
    throw new HttpsError('not-found', 'That product no longer exists.')
  }
  await productRef.delete()
  return { deleted: true }
})

export const updateOrderStatus = onCall(async (request) => {
  const adminUid = requireAdmin(request)
  if (!isRecord(request.data)) {
    throw new HttpsError('invalid-argument', 'Order update details are required.')
  }
  const id = requiredString(request.data.orderId, 'order ID', 1, 128)
  const nextStatus = request.data.status
  const nextPaymentStatus = request.data.paymentStatus
  if (!ORDER_STATUSES.includes(nextStatus as (typeof ORDER_STATUSES)[number])) {
    throw new HttpsError('invalid-argument', 'The order status is invalid.')
  }
  if (
    nextPaymentStatus !== undefined &&
    !PAYMENT_STATUSES.includes(nextPaymentStatus as (typeof PAYMENT_STATUSES)[number])
  ) {
    throw new HttpsError('invalid-argument', 'The payment status is invalid.')
  }
  const status = nextStatus as (typeof ORDER_STATUSES)[number]
  const paymentStatus = nextPaymentStatus as
    | (typeof PAYMENT_STATUSES)[number]
    | undefined
  const orderRef = db.collection('orders').doc(id)
  await db.runTransaction(async (transaction) => {
    const order = await transaction.get(orderRef)
    if (!order.exists) {
      throw new HttpsError('not-found', 'That order no longer exists.')
    }
    const currentStatus = order.get('status') as string
    const allowedTransitions: Record<string, readonly string[]> = {
      pending: ['confirmed', 'cancelled'],
      confirmed: ['shipped', 'cancelled'],
      shipped: ['delivered', 'cancelled'],
      delivered: [],
      cancelled: [],
    }
    if (status !== currentStatus && !allowedTransitions[currentStatus]?.includes(status)) {
      throw new HttpsError(
        'failed-precondition',
        `An order cannot move from ${currentStatus} to ${String(nextStatus)}.`,
      )
    }
    const currentPaymentStatus = order.get('paymentStatus')
    if (paymentStatus === 'paid' && status !== 'delivered' && currentStatus !== 'delivered') {
      throw new HttpsError(
        'failed-precondition',
        'Cash on Delivery can only be marked paid after delivery.',
      )
    }
    if (paymentStatus === 'cancelled' && status !== 'cancelled') {
      throw new HttpsError(
        'failed-precondition',
        'Payment can only be cancelled when the order is cancelled.',
      )
    }
    if (status === 'cancelled' && currentStatus !== 'cancelled' && currentPaymentStatus === 'paid') {
      throw new HttpsError('failed-precondition', 'A paid order cannot be cancelled.')
    }
    const stockUpdates: {
      ref: DocumentReference
      productId: string
      stock: number
      quantity: number
      soldCount?: number
    }[] = []
    if (status === 'cancelled' && currentStatus !== 'cancelled') {
      const rawItems: unknown = order.get('items')
      if (!Array.isArray(rawItems)) {
        throw new HttpsError('failed-precondition', 'This order has invalid item records.')
      }
      const restoredItems = rawItems.filter(
        (item): item is { productId: string; quantity: number } =>
          isRecord(item) &&
          typeof item.productId === 'string' &&
          typeof item.quantity === 'number' &&
          Number.isSafeInteger(item.quantity) &&
          item.quantity > 0,
      )
      if (restoredItems.length !== rawItems.length) {
        throw new HttpsError('failed-precondition', 'This order has invalid item records.')
      }
      const productRefs = restoredItems.map((item) =>
        db.collection('products').doc(item.productId),
      )
      const products = await Promise.all(productRefs.map((ref) => transaction.get(ref)))
      products.forEach((product, index) => {
        if (!product.exists) return
        const currentStock = product.get('stock')
        if (typeof currentStock !== 'number' || !Number.isSafeInteger(currentStock) || currentStock < 0) {
          throw new HttpsError('failed-precondition', 'A product has invalid stock data.')
        }
        const soldCount = product.get('soldCount')
        const quantity = restoredItems[index].quantity
        stockUpdates.push({
          ref: product.ref,
          productId: product.id,
          stock: currentStock + quantity,
          quantity,
          ...(typeof soldCount === 'number' && Number.isSafeInteger(soldCount)
            ? { soldCount: Math.max(0, soldCount - quantity) }
            : {}),
        })
      })
    }
    stockUpdates.forEach(({ ref, productId, stock: restoredStock, quantity, soldCount }) => {
      transaction.update(ref, {
        stock: restoredStock,
        ...(soldCount === undefined ? {} : { soldCount }),
        updatedAt: FieldValue.serverTimestamp(),
      })
      transaction.set(db.collection('inventory').doc(), {
        productId,
        orderId: id,
        movementType: 'restock',
        quantity,
        previousStock: restoredStock - quantity,
        newStock: restoredStock,
        actorUid: adminUid,
        createdAt: FieldValue.serverTimestamp(),
      })
    })
    transaction.update(orderRef, {
      status,
      ...(status === 'cancelled'
        ? { paymentStatus: 'cancelled' }
        : paymentStatus === undefined
          ? {}
          : { paymentStatus }),
      updatedAt: FieldValue.serverTimestamp(),
      updatedBy: adminUid,
    })
  })
  return { updated: true }
})

export const getAdminDashboard = onCall(async (request) => {
  requireAdmin(request)
  const monthStart = new Date()
  monthStart.setUTCDate(1)
  monthStart.setUTCHours(0, 0, 0, 0)
  monthStart.setUTCMonth(monthStart.getUTCMonth() - 5)
  const [ordersCount, customersCount, productsCount, revenue, bestSellers, lowStock, chartOrders] =
    await Promise.all([
      db.collection('orders').count().get(),
      db.collection('users').count().get(),
      db.collection('products').count().get(),
      db.collection('orders').where('paymentStatus', '==', 'paid').aggregate({ totalRevenue: AggregateField.sum('total') }).get(),
      db.collection('products').orderBy('soldCount', 'desc').limit(5).get(),
      db.collection('products').where('stock', '<=', 5).limit(100).get(),
      db.collection('orders').where('createdAt', '>=', Timestamp.fromDate(monthStart)).get(),
    ])
  const months = Array.from({ length: 6 }, (_, index) => {
    const date = new Date(monthStart)
    date.setUTCMonth(date.getUTCMonth() + index)
    return {
      key: `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`,
      label: date.toLocaleString('en', { month: 'short', timeZone: 'UTC' }),
      revenue: 0,
    }
  })
  const monthIndex = new Map(months.map((month, index) => [month.key, index]))
  chartOrders.docs.forEach((snapshot) => {
    const order = snapshot.data()
    if (order.paymentStatus !== 'paid' || typeof order.total !== 'number') return
    const createdAt = order.createdAt
    if (!(createdAt instanceof Timestamp)) return
    const date = createdAt.toDate()
    const key = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`
    const index = monthIndex.get(key)
    if (index !== undefined) months[index].revenue += order.total
  })
  return {
    totals: {
      orders: ordersCount.data().count,
      customers: customersCount.data().count,
      products: productsCount.data().count,
      revenue: revenue.data().totalRevenue ?? 0,
    },
    revenueByMonth: months,
    bestSellers: bestSellers.docs.map((snapshot) => ({
      id: snapshot.id,
      name: snapshot.get('name'),
      soldCount: snapshot.get('soldCount') ?? 0,
      price: snapshot.get('price'),
    })),
    lowStock: lowStock.docs.filter((snapshot) => snapshot.get('published') === true).map((snapshot) => ({
      id: snapshot.id,
      name: snapshot.get('name'),
      stock: snapshot.get('stock'),
    })),
  }
})
