import type { ComponentType } from "react"

// Capabilities the UI userspace may export. Core's navigation builder consumes
// these; userspace modules must `satisfies AppCapability[]` so tsc gates publish.

export interface AppTabCapability {
  readonly kind: "app-tab"
  readonly name: string
  readonly title: string
  /** Ionicons name for the tab bar */
  readonly icon: string
  readonly Component: ComponentType
}

export interface SettingsScreenCapability {
  readonly kind: "settings-screen"
  readonly name: string
  readonly title: string
  readonly Component: ComponentType
}

/** Client-side chat augmentation: extra renderers or quick actions for a task type. */
export interface ChatbotCapability {
  readonly kind: "chatbot"
  readonly name: string
  readonly taskTypeId: string
  /** Optional custom message renderer */
  readonly MessageComponent?: ComponentType<{ content: string }>
}

export type AppCapability = AppTabCapability | SettingsScreenCapability | ChatbotCapability
