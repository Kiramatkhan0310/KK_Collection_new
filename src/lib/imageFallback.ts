import type { SyntheticEvent } from 'react'

export const fallbackImage = '/images/product-placeholder.svg'

export function handleImageError(event: SyntheticEvent<HTMLImageElement>) {
  const image = event.currentTarget
  if (image.dataset.fallbackApplied) return
  image.dataset.fallbackApplied = 'true'
  image.src = fallbackImage
}
