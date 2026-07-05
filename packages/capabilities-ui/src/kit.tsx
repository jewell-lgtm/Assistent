import { useState, type PropsWithChildren, type ReactElement } from "react"
import {
  ActivityIndicator,
  FlatList,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
  type KeyboardTypeOptions
} from "react-native"

// Stable component kit for userspace features — compose these instead of
// hand-rolling RN primitives. Keep additions minimal; this is the surface
// the coding agent is told to use (see docs/pi-userspace-guide or similar).

export const Screen = ({ children }: PropsWithChildren) => <View style={styles.screen}>{children}</View>

export const Title = ({ children }: PropsWithChildren) => <Text style={styles.title}>{children}</Text>
export const Body = ({ children }: PropsWithChildren) => <Text style={styles.body}>{children}</Text>
export const Caption = ({ children }: PropsWithChildren) => <Text style={styles.caption}>{children}</Text>

export interface ButtonProps {
  readonly title: string
  readonly onPress: () => void
  readonly variant?: "primary" | "secondary" | "danger"
  readonly disabled?: boolean
  readonly loading?: boolean
}

export const Button = ({ title, onPress, variant = "primary", disabled = false, loading = false }: ButtonProps) => (
  <TouchableOpacity
    style={[
      styles.button,
      variant === "secondary" && styles.buttonSecondary,
      variant === "danger" && styles.buttonDanger,
      disabled && styles.buttonDisabled
    ]}
    onPress={onPress}
    disabled={disabled || loading}
  >
    {loading ? (
      <ActivityIndicator color={variant === "secondary" ? "#0a7" : "#fff"} />
    ) : (
      <Text style={[styles.buttonText, variant === "secondary" && styles.buttonTextSecondary]}>{title}</Text>
    )}
  </TouchableOpacity>
)

export interface TextFieldProps {
  readonly label: string
  readonly value: string
  readonly onChangeText: (text: string) => void
  readonly placeholder?: string
  readonly keyboardType?: KeyboardTypeOptions
}

export const TextField = ({ label, value, onChangeText, placeholder, keyboardType }: TextFieldProps) => (
  <View style={styles.field}>
    <Text style={styles.fieldLabel}>{label}</Text>
    <TextInput
      style={styles.fieldInput}
      value={value}
      onChangeText={onChangeText}
      placeholder={placeholder}
      keyboardType={keyboardType}
    />
  </View>
)

export interface FormField {
  readonly key: string
  readonly label: string
  readonly placeholder?: string
}

export interface FormProps {
  readonly fields: ReadonlyArray<FormField>
  readonly onSubmit: (values: Record<string, string>) => Promise<void>
  readonly submitLabel?: string
}

// The one obvious way to submit data. Caller owns the transport — wire
// onSubmit to a typed HttpApiClient call, e.g.:
//
//   <Form
//     fields={[{ key: "title", label: "Title" }]}
//     onSubmit={(values) => Effect.runPromise(client.items.create({ payload: values }))}
//   />
export const Form = ({ fields, onSubmit, submitLabel = "Submit" }: FormProps) => {
  const [values, setValues] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async () => {
    setBusy(true)
    setError(null)
    try {
      await onSubmit(values)
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <View style={styles.form}>
      {fields.map((field) => (
        <TextField
          key={field.key}
          label={field.label}
          placeholder={field.placeholder}
          value={values[field.key] ?? ""}
          onChangeText={(text) => setValues((prev) => ({ ...prev, [field.key]: text }))}
        />
      ))}
      <Button title={submitLabel} onPress={() => void submit()} loading={busy} />
      {error !== null && <Text style={styles.formError}>{error}</Text>}
    </View>
  )
}

export interface ListProps<T> {
  readonly data: ReadonlyArray<T>
  readonly renderItem: (item: T) => ReactElement
  readonly keyExtractor: (item: T, index: number) => string
  readonly emptyText?: string
}

export const List = <T,>({ data, renderItem, keyExtractor, emptyText = "Nothing here yet" }: ListProps<T>) =>
  data.length === 0 ? (
    <Text style={styles.listEmpty}>{emptyText}</Text>
  ) : (
    <FlatList data={data as Array<T>} renderItem={({ item }) => renderItem(item)} keyExtractor={keyExtractor} />
  )

export const Spacer = ({ size = 12 }: { readonly size?: number }) => <View style={{ height: size, width: size }} />

const styles = StyleSheet.create({
  screen: { flex: 1, padding: 16, backgroundColor: "#fff" },
  title: { fontSize: 22, fontWeight: "700" },
  body: { fontSize: 15, color: "#222" },
  caption: { fontSize: 12, color: "#666" },
  button: { backgroundColor: "#0a7", borderRadius: 6, padding: 10, alignItems: "center" },
  buttonSecondary: { backgroundColor: "#eee" },
  buttonDanger: { backgroundColor: "#c0392b" },
  buttonDisabled: { opacity: 0.5 },
  buttonText: { color: "#fff", fontWeight: "700" },
  buttonTextSecondary: { color: "#0a7" },
  field: { gap: 4 },
  fieldLabel: { fontSize: 12, color: "#666" },
  fieldInput: { borderWidth: 1, borderColor: "#ccc", borderRadius: 6, padding: 8 },
  form: { gap: 12 },
  formError: { color: "#c00", fontSize: 12 },
  listEmpty: { fontSize: 12, color: "#666", textAlign: "center", padding: 16 }
})
