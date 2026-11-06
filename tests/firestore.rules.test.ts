import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing'
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  query,
  runTransaction,
  serverTimestamp,
  setDoc,
  Timestamp,
  updateDoc,
  where,
  writeBatch,
  type Firestore,
} from 'firebase/firestore'

const projectId = 'demo-kk-collection'
const customerUid = 'customer-one'
const customerEmail = 'customer@example.com'
const otherCustomerUid = 'customer-two'
const otherCustomerEmail = 'other@example.com'
const adminUid = 'admin-one'

type OrderItem = {
  productId: string
  name: string
  quantity: number
  unitPrice: number
  lineTotal: number
}

type Order = {
  orderNumber: string
  userId: string
  customerEmail: string
  customer: {
    fullName: string
    phone: string
    address: string
    city: string
  }
  subtotal: number
  deliveryFee: number
  total: number
  paymentMethod: string
  paymentStatus: string
  status: string
  createdAt: ReturnType<typeof serverTimestamp>
  updatedAt: ReturnType<typeof serverTimestamp>
  itemCount: number
}

let testEnv: RulesTestEnvironment

function customerDb() {
  return testEnv.authenticatedContext(customerUid, { email: customerEmail }).firestore()
}

function otherCustomerDb() {
  return testEnv
    .authenticatedContext(otherCustomerUid, { email: otherCustomerEmail })
    .firestore()
}

function adminDb() {
  return testEnv.authenticatedContext(adminUid, { admin: true }).firestore()
}

function unauthenticatedDb() {
  return testEnv.unauthenticatedContext().firestore()
}

function validOrder(
  userId = customerUid,
  email = customerEmail,
  itemCount = 1,
): Order {
  return {
    orderNumber: 'KK-123',
    userId,
    customerEmail: email,
    customer: {
      fullName: 'Test Customer',
      phone: '+92 300 1234567',
      address: '123 Test Street',
      city: 'Lahore',
    },
    subtotal: 2000,
    deliveryFee: 250,
    total: 2250,
    paymentMethod: 'cod',
    paymentStatus: 'pending',
    status: 'pending',
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    itemCount,
  }
}

function validItem(index = 0): OrderItem {
  return {
    productId: `product-${index + 1}`,
    name: 'Test Cream',
    quantity: 2,
    unitPrice: 1000,
    lineTotal: 2000,
  }
}

function orderBatch(
  db: Firestore,
  orderId: string,
  itemCount: number,
  makeItem: (index: number) => Record<string, unknown> = validItem,
) {
  const batch = writeBatch(db)
  batch.set(doc(db, 'orders', orderId), validOrder(customerUid, customerEmail, itemCount))
  for (let index = 0; index < itemCount; index += 1) {
    batch.set(
      doc(db, 'orders', orderId, 'items', `item-${index + 1}`),
      makeItem(index),
    )
  }
  return batch
}

async function seedOrder(
  orderId = 'order-one',
  userId = customerUid,
  email = customerEmail,
  items: OrderItem[] = [validItem()],
) {
  await testEnv.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore()
    await setDoc(doc(db, 'orders', orderId), {
      ...validOrder(userId, email, items.length),
      createdAt: Timestamp.now(),
      updatedAt: Timestamp.now(),
    })
    for (const [index, item] of items.entries()) {
      await setDoc(doc(db, 'orders', orderId, 'items', `item-${index + 1}`), item)
    }
  })
}

async function expectDeniedWithoutExpressionLimit(operation: Promise<unknown>) {
  let caught: unknown
  try {
    await operation
  } catch (error) {
    caught = error
  }

  expect(caught, 'Expected Firestore to deny the operation').toBeDefined()
  const errorCode =
    typeof caught === 'object' && caught !== null && 'code' in caught
      ? caught.code
      : undefined
  expect(errorCode).toBe('permission-denied')
  const message = caught instanceof Error ? caught.message : String(caught)
  expect(message).not.toMatch(/maximum of 1000 expressions to evaluate has been reached/i)
}

beforeAll(async () => {
  testEnv = await initializeTestEnvironment({
    projectId,
    firestore: {
      host: '127.0.0.1',
      port: 8080,
      rules: readFileSync('firestore.rules', 'utf8'),
    },
  })
})

beforeEach(async () => {
  await testEnv.clearFirestore()
})

afterAll(async () => {
  await testEnv.cleanup()
})

describe('order creation and item subcollections', () => {
  for (const itemCount of [1, 3, 4, 20]) {
    it(`allows a valid parent and ${itemCount} item(s) in one atomic batch`, async () => {
      await assertSucceeds(
        orderBatch(customerDb(), `valid-${itemCount}-items`, itemCount).commit(),
      )
    })
  }

  it('rejects unauthenticated order and item creation', async () => {
    await expectDeniedWithoutExpressionLimit(
      orderBatch(unauthenticatedDb(), 'unauthenticated-order', 1).commit(),
    )
  })

  it('requires exact parent fields, valid owner/email, COD, pending states, totals, and itemCount', async () => {
    const db = customerDb()
    const extraField = { ...validOrder(), extra: true }
    const missingField = { ...validOrder() } as Record<string, unknown>
    delete missingField.orderNumber
    const invalidCases: Array<[string, Record<string, unknown>]> = [
      ['extra-field', extraField],
      ['missing-field', missingField],
      ['wrong-owner', validOrder(otherCustomerUid, customerEmail)],
      ['wrong-email', validOrder(customerUid, otherCustomerEmail)],
      ['invalid-email', validOrder(customerUid, 'not-an-email')],
      ['non-cod', { ...validOrder(), paymentMethod: 'card' }],
      ['non-pending-order', { ...validOrder(), status: 'confirmed' }],
      ['non-pending-payment', { ...validOrder(), paymentStatus: 'paid' }],
      ['invalid-subtotal', { ...validOrder(), subtotal: -1 }],
      ['invalid-item-count-zero', validOrder(customerUid, customerEmail, 0)],
      ['invalid-item-count-large', validOrder(customerUid, customerEmail, 21)],
    ]

    for (const [id, order] of invalidCases) {
      await expectDeniedWithoutExpressionLimit(
        setDoc(doc(db, 'orders', `invalid-parent-${id}`), order),
      )
    }
  })

  it('denies a parent with a missing or unexpected required-schema field', async () => {
    const db = customerDb()
    const missingCustomerField = validOrder() as unknown as Record<string, unknown>
    missingCustomerField.customer = {
      fullName: 'Test Customer',
      phone: '+92 300 1234567',
      address: '123 Test Street',
    }
    const extraCustomerField = validOrder() as unknown as Record<string, unknown>
    extraCustomerField.customer = {
      fullName: 'Test Customer',
      phone: '+92 300 1234567',
      address: '123 Test Street',
      city: 'Lahore',
      extra: true,
    }

    await expectDeniedWithoutExpressionLimit(
      setDoc(doc(db, 'orders', 'missing-customer-field'), missingCustomerField),
    )
    await expectDeniedWithoutExpressionLimit(
      setDoc(doc(db, 'orders', 'extra-customer-field'), extraCustomerField),
    )
  })

  it('rejects invalid, missing, and extra item fields without expression exhaustion', async () => {
    const db = customerDb()
    const invalidItems: Array<[string, Record<string, unknown>]> = [
      ['bad-product-id', { ...validItem(), productId: 7 }],
      ['bad-name', { ...validItem(), name: 7 }],
      ['bad-quantity-low', { ...validItem(), quantity: 0 }],
      ['bad-quantity-high', { ...validItem(), quantity: 21 }],
      ['bad-quantity-fraction', { ...validItem(), quantity: 1.5 }],
      ['bad-unit-price-low', { ...validItem(), unitPrice: -1 }],
      ['bad-unit-price-high', { ...validItem(), unitPrice: 100000001 }],
      ['bad-line-total-low', { ...validItem(), lineTotal: -1 }],
      ['bad-line-total-high', { ...validItem(), lineTotal: 100000001 }],
      ['extra-item-field', { ...validItem(), unexpected: true }],
    ]
    for (const field of ['productId', 'name', 'quantity', 'unitPrice', 'lineTotal']) {
      const missingField = { ...validItem() } as unknown as Record<string, unknown>
      delete missingField[field]
      invalidItems.push([`missing-${field}`, missingField])
    }

    for (const [id, item] of invalidItems) {
      await expectDeniedWithoutExpressionLimit(
        orderBatch(db, `invalid-item-${id}`, 1, () => item).commit(),
      )
    }
  })

  it('rejects item creation when no parent order exists', async () => {
    const db = customerDb()
    await expectDeniedWithoutExpressionLimit(
      setDoc(doc(db, 'orders', 'missing-parent', 'items', 'item-1'), validItem()),
    )
  })

  it('rejects item creation under another customer’s existing order', async () => {
    await seedOrder('other-orders-order', otherCustomerUid, otherCustomerEmail, [])
    await expectDeniedWithoutExpressionLimit(
      setDoc(
        doc(customerDb(), 'orders', 'other-orders-order', 'items', 'attempted-item'),
        validItem(),
      ),
    )
  })

  it('denies item additions after the initial checkout batch', async () => {
    const db = customerDb()
    await assertSucceeds(
      setDoc(doc(db, 'orders', 'parent-first'), validOrder()),
    )
    await expectDeniedWithoutExpressionLimit(
      setDoc(doc(db, 'orders', 'parent-first', 'items', 'late-item'), validItem()),
    )
  })

  it('allows an owner to read their order and items, but denies another customer', async () => {
    await seedOrder()
    await assertSucceeds(getDoc(doc(customerDb(), 'orders', 'order-one')))
    await assertSucceeds(
      getDoc(doc(customerDb(), 'orders', 'order-one', 'items', 'item-1')),
    )
    await expectDeniedWithoutExpressionLimit(
      getDoc(doc(otherCustomerDb(), 'orders', 'order-one')),
    )
    await expectDeniedWithoutExpressionLimit(
      getDoc(doc(otherCustomerDb(), 'orders', 'order-one', 'items', 'item-1')),
    )
  })

  it('allows an admin to read all order parents and item documents', async () => {
    await seedOrder('customer-orders-order', otherCustomerUid, otherCustomerEmail)
    await assertSucceeds(getDoc(doc(adminDb(), 'orders', 'customer-orders-order')))
    await assertSucceeds(
      getDoc(doc(adminDb(), 'orders', 'customer-orders-order', 'items', 'item-1')),
    )
  })

  it('allows parent-only requests but documents that itemCount does not prove completeness', async () => {
    const db = customerDb()
    await assertSucceeds(
      setDoc(
        doc(db, 'orders', 'parent-only-unverified'),
        validOrder(customerUid, customerEmail, 3),
      ),
    )
    const parent = await getDoc(doc(db, 'orders', 'parent-only-unverified'))
    expect(parent.exists()).toBe(true)
    expect(parent.data().itemCount).toBe(3)

    const absentItem = await getDoc(
      doc(db, 'orders', 'parent-only-unverified', 'items', 'item-1'),
    )
    expect(absentItem.exists()).toBe(false)
    await expectDeniedWithoutExpressionLimit(
      setDoc(
        doc(db, 'orders', 'parent-only-unverified', 'items', 'late-item'),
        validItem(),
      ),
    )
    // This remains an unverified customer request; itemCount is not proof of completeness.
  })

  it('rejects an invalid item batch atomically without creating its parent or item', async () => {
    const db = customerDb()
    const invalidItem = { ...validItem(), quantity: 0 }
    await expectDeniedWithoutExpressionLimit(
      orderBatch(db, 'invalid-atomic-batch', 1, () => invalidItem).commit(),
    )

    const admin = adminDb()
    expect((await getDoc(doc(admin, 'orders', 'invalid-atomic-batch'))).exists()).toBe(false)
    expect(
      (
        await getDoc(
          doc(admin, 'orders', 'invalid-atomic-batch', 'items', 'item-1'),
        )
      ).exists(),
    ).toBe(false)
  })

  it('allows an admin to make an explicitly permitted status transition', async () => {
    await seedOrder()
    await assertSucceeds(
      updateDoc(doc(adminDb(), 'orders', 'order-one'), {
        status: 'confirmed',
        updatedAt: serverTimestamp(),
      }),
    )
  })

  it('rejects invalid admin status transitions and protected-field changes', async () => {
    await seedOrder()
    const db = adminDb()
    await expectDeniedWithoutExpressionLimit(
      updateDoc(doc(db, 'orders', 'order-one'), {
        status: 'delivered',
        updatedAt: serverTimestamp(),
      }),
    )
    await expectDeniedWithoutExpressionLimit(
      updateDoc(doc(db, 'orders', 'order-one'), {
        total: 1,
        status: 'confirmed',
        updatedAt: serverTimestamp(),
      }),
    )
  })

  it('denies customer item updates and deletes and all order deletions', async () => {
    await seedOrder()
    const db = customerDb()
    await expectDeniedWithoutExpressionLimit(
      updateDoc(doc(db, 'orders', 'order-one', 'items', 'item-1'), {
        quantity: 3,
      }),
    )
    await expectDeniedWithoutExpressionLimit(
      deleteDoc(doc(db, 'orders', 'order-one', 'items', 'item-1')),
    )
    await expectDeniedWithoutExpressionLimit(
      updateDoc(doc(db, 'orders', 'order-one'), {
        status: 'confirmed',
        updatedAt: serverTimestamp(),
      }),
    )
    await expectDeniedWithoutExpressionLimit(
      deleteDoc(doc(adminDb(), 'orders', 'order-one')),
    )
  })
})

describe('admin authorization', () => {
  it('does not authorize an ordinary customer for admin product operations', async () => {
    await expectDeniedWithoutExpressionLimit(
      setDoc(doc(customerDb(), 'products', 'customer-product'), { published: true }),
    )
  })

  it('allows an admin to create, update, and delete products', async () => {
    const db = adminDb()
    const productRef = doc(db, 'products', 'admin-product')

    await assertSucceeds(setDoc(productRef, { published: false }))
    await assertSucceeds(updateDoc(productRef, { published: true }))
    await assertSucceeds(deleteDoc(productRef))
  })
})

describe('customer profile ownership', () => {
  it('allows a customer to create and update only their own profile', async () => {
    const db = customerDb()
    const profileRef = doc(db, 'users', customerUid)

    await assertSucceeds(runTransaction(db, async (transaction) => {
      const profile = await transaction.get(profileRef)
      if (profile.exists()) return
      transaction.set(profileRef, {
        email: customerEmail,
        displayName: 'Test Customer',
        createdAt: serverTimestamp(),
      })
    }))
    await assertSucceeds(
      updateDoc(profileRef, { displayName: 'Updated Customer' }),
    )
    await assertSucceeds(getDoc(profileRef))
    await expectDeniedWithoutExpressionLimit(
      getDoc(doc(otherCustomerDb(), 'users', customerUid)),
    )
  })

  it('rejects another-user profile creation and customer-supplied admin claims', async () => {
    const db = customerDb()
    await expectDeniedWithoutExpressionLimit(
      setDoc(doc(db, 'users', otherCustomerUid), {
        email: customerEmail,
        displayName: 'Impersonated Customer',
        createdAt: serverTimestamp(),
      }),
    )
    await expectDeniedWithoutExpressionLimit(
      setDoc(doc(db, 'users', customerUid), {
        email: customerEmail,
        displayName: 'Test Customer',
        createdAt: serverTimestamp(),
        admin: true,
      }),
    )
  })
})

describe('public product catalogue access', () => {
  it('allows visitors to query published products without exposing drafts', async () => {
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), 'products', 'published-product'), {
        name: 'Published product',
        published: true,
      })
      await setDoc(doc(context.firestore(), 'products', 'draft-product'), {
        name: 'Draft product',
        published: false,
      })
    })

    const db = unauthenticatedDb()
    const publicProducts = await getDocs(
      query(collection(db, 'products'), where('published', '==', true)),
    )
    expect(publicProducts.docs.map((product) => product.id)).toEqual([
      'published-product',
    ])
    await assertSucceeds(getDoc(doc(db, 'products', 'published-product')))
    await expectDeniedWithoutExpressionLimit(
      getDoc(doc(db, 'products', 'draft-product')),
    )
  })
})

describe('product write protection', () => {
  it('rejects customer product create, update, and delete operations', async () => {
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), 'products', 'existing-product'), {
        published: true,
      })
    })

    const db = customerDb()
    await expectDeniedWithoutExpressionLimit(
      setDoc(doc(db, 'products', 'new-product'), { published: true }),
    )
    await expectDeniedWithoutExpressionLimit(
      updateDoc(doc(db, 'products', 'existing-product'), { published: false }),
    )
    await expectDeniedWithoutExpressionLimit(
      deleteDoc(doc(db, 'products', 'existing-product')),
    )
  })
})

describe('wishlist ownership', () => {
  it('allows an owner to create, read, and delete their own wishlist item', async () => {
    const db = customerDb()
    const itemRef = doc(db, 'wishlists', customerUid, 'items', 'product-1')

    await assertSucceeds(
      setDoc(itemRef, { productId: 'product-1', createdAt: serverTimestamp() }),
    )
    await assertSucceeds(getDoc(itemRef))
    await assertSucceeds(deleteDoc(itemRef))
  })

  it('denies another customer and unauthenticated access to a wishlist', async () => {
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await setDoc(
        doc(context.firestore(), 'wishlists', customerUid, 'items', 'product-1'),
        { productId: 'product-1', createdAt: Timestamp.now() },
      )
    })

    await expectDeniedWithoutExpressionLimit(
      getDoc(doc(otherCustomerDb(), 'wishlists', customerUid, 'items', 'product-1')),
    )
    await expectDeniedWithoutExpressionLimit(
      getDoc(doc(unauthenticatedDb(), 'wishlists', customerUid, 'items', 'product-1')),
    )
    await expectDeniedWithoutExpressionLimit(
      setDoc(
        doc(otherCustomerDb(), 'wishlists', customerUid, 'items', 'product-2'),
        { productId: 'product-2', createdAt: serverTimestamp() },
      ),
    )
  })
})

describe('default-deny behavior', () => {
  it('denies reads and writes to unmatched paths', async () => {
    const db = customerDb()
    await expectDeniedWithoutExpressionLimit(getDoc(doc(db, 'unmatched', 'document')))
    await expectDeniedWithoutExpressionLimit(
      setDoc(doc(db, 'unmatched', 'document'), { value: true }),
    )
  })

  it('denies inventory reads and writes', async () => {
    const db = adminDb()
    await expectDeniedWithoutExpressionLimit(getDoc(doc(db, 'inventory', 'item-one')))
    await expectDeniedWithoutExpressionLimit(
      setDoc(doc(db, 'inventory', 'item-one'), { quantity: 1 }),
    )
  })
})
