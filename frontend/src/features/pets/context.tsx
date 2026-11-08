import { createContext, useContext } from 'react'
import type { Pet } from './api'

export const PetContext = createContext<{ petId?: string; pet?: Pet }>({})
export function usePet() { return useContext(PetContext) }
