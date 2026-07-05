import { Component, type ReactNode } from "react"
import { Text, View } from "react-native"

// Per-tab isolation: a crashing userspace module breaks its own tab, not the app.
export class ErrorBoundary extends Component<
  { readonly name: string; readonly children: ReactNode },
  { readonly error?: Error }
> {
  override state: { error?: Error } = {}

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  override render() {
    if (this.state.error !== undefined) {
      return (
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 24, gap: 8 }}>
          <Text style={{ fontWeight: "700" }}>module “{this.props.name}” crashed</Text>
          <Text style={{ color: "#c00" }}>{this.state.error.message || String(this.state.error)}</Text>
        </View>
      )
    }
    return this.props.children
  }
}
