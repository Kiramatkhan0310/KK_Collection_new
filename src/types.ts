export type Product = {
  id: string
  name: string
  brand: string
  category: string
  description: string
  price: number
  compareAtPrice: number
  stock: number
  imageUrl: string
  imageAlt: string
  imagePath?: string
  badge?: string
  featured: boolean
  published: boolean
  soldCount?: number
  createdAt?: { toDate: () => Date }
}
