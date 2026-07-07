import { createContext, useContext } from "react"

// Lets any screen (CodeScreen's dev area) open the pairing flow without a
// nav dependency — App.tsx owns the phase state and provides the real repair.
export const PairingUiContext = createContext<{ readonly repair: () => void }>({ repair: () => {} })
export const usePairingUi = () => useContext(PairingUiContext)
