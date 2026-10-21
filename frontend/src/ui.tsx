import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ChangeEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

const cx = (...parts: Array<string | false | null | undefined>) =>
  parts.filter(Boolean).join(" ");

/* ---------------- prop types (contextual typing for callers) ---------------- */
type BaseProps = {
  [key: string]: any;
  className?: string;
  children?: ReactNode;
};

type ButtonProps = BaseProps & {
  appearance?:
    | "primary"
    | "secondary"
    | "subtle"
    | "transparent"
    | "outline"
    | "accent"
    | "danger";
  size?: "small" | "medium" | "large";
  icon?: ReactNode;
  iconPosition?: "before" | "after";
  disabled?: boolean;
  type?: "button" | "submit" | "reset";
  onClick?: (event: ReactMouseEvent<HTMLButtonElement>) => void;
};

type FieldProps = BaseProps & {
  label?: ReactNode;
  required?: boolean;
  hint?: ReactNode;
  validationMessage?: ReactNode;
};

type InputProps = BaseProps & {
  value?: string | number;
  onChange?: (
    event: ChangeEvent<HTMLInputElement>,
    data: { value: string },
  ) => void;
  onKeyDown?: (event: ReactKeyboardEvent<HTMLInputElement>) => void;
  contentBefore?: ReactNode;
  placeholder?: string;
  type?: string;
  disabled?: boolean;
  autoFocus?: boolean;
};

type TextareaProps = BaseProps & {
  value?: string;
  onChange?: (
    event: ChangeEvent<HTMLTextAreaElement>,
    data: { value: string },
  ) => void;
  placeholder?: string;
  disabled?: boolean;
  rows?: number;
};

type SelectProps = BaseProps & {
  value?: string | number;
  onChange?: (
    event: ChangeEvent<HTMLSelectElement>,
    data: { value: string },
  ) => void;
  disabled?: boolean;
  icon?: ReactNode;
};

type CheckboxProps = BaseProps & {
  checked?: boolean;
  onChange?: (
    event: ChangeEvent<HTMLInputElement>,
    data: { checked: boolean },
  ) => void;
  label?: ReactNode;
  disabled?: boolean;
};

type SwitchProps = BaseProps & {
  checked?: boolean;
  onChange?: (event: unknown, data: { checked: boolean }) => void;
  label?: ReactNode;
  disabled?: boolean;
};

type BadgeProps = BaseProps & {
  appearance?: "filled" | "outline" | "tint" | "ghost";
  color?:
    | "brand"
    | "danger"
    | "important"
    | "informative"
    | "severe"
    | "subtle"
    | "success"
    | "warning";
  size?: "small" | "medium" | "large";
};

type TabListProps = BaseProps & {
  selectedValue?: string;
  onTabSelect?: (event: unknown, data: { value: string }) => void;
};

type TabProps = BaseProps & { value: string; icon?: ReactNode };

type TooltipProps = BaseProps & {
  content: ReactNode;
  relationship?: string;
};

type SpinnerProps = BaseProps & { label?: ReactNode; size?: string };

type DialogProps = BaseProps & {
  open?: boolean;
  onOpenChange?: (event: unknown, data: { open: boolean }) => void;
};

/* ---------------- theme ---------------- */
type ThemeMode = "light" | "dark" | "auto";

const ThemeContext = createContext<{
  mode: ThemeMode;
  resolved: "light" | "dark";
  setMode: (mode: ThemeMode) => void;
}>({ mode: "auto", resolved: "light", setMode: () => {} });

function systemDark() {
  return (
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-color-scheme: dark)").matches
  );
}

function resolve(mode: ThemeMode): "light" | "dark" {
  return mode === "auto" ? (systemDark() ? "dark" : "light") : mode;
}

function applyTheme(mode: ThemeMode) {
  const resolved = resolve(mode);
  document.documentElement.dataset.theme = resolved;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", resolved === "dark" ? "#151517" : "#ffffff");
  return resolved;
}

export function useTheme() {
  return useContext(ThemeContext);
}

export const webLightTheme = {};

export function FluentProvider({
  className,
  children,
}: {
  theme?: Any;
  className?: string;
  children: ReactNode;
}) {
  const [mode, setMode] = useState<ThemeMode>(() => {
    const stored = localStorage.getItem("zhixu-theme");
    return stored === "light" || stored === "dark" ? stored : "auto";
  });
  const [resolved, setResolved] = useState<"light" | "dark">(() =>
    typeof document === "undefined"
      ? "light"
      : ((document.documentElement.dataset.theme as "light" | "dark") ??
        resolve(mode)),
  );

  useEffect(() => {
    setResolved(applyTheme(mode));
    localStorage.setItem("zhixu-theme", mode);
  }, [mode]);

  useEffect(() => {
    if (mode !== "auto") return;
    const query = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => setResolved(applyTheme("auto"));
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, [mode]);

  const value = useMemo(
    () => ({ mode, resolved, setMode }),
    [mode, resolved],
  );

  return (
    <ThemeContext.Provider value={value}>
      <div className={cx("app-provider", className)}>{children}</div>
    </ThemeContext.Provider>
  );
}

/* ---------------- button ---------------- */
export function Button({
  appearance = "secondary",
  size = "medium",
  icon,
  iconPosition = "before",
  disabled,
  className,
  children,
  ...rest
}: ButtonProps) {
  const cls = cx(
    "btn",
    appearance === "primary" && "btn--primary",
    appearance === "accent" && "btn--accent",
    (appearance === "subtle" || appearance === "transparent") && "btn--subtle",
    appearance === "danger" && "btn--danger",
    size === "small" && "btn--sm",
    (children === undefined || children === null || children === false) &&
      "btn--icon",
    className,
  );
  return (
    <button
      type="button"
      className={cls}
      disabled={disabled}
      {...rest}
      onClick={disabled ? undefined : rest.onClick}
    >
      {iconPosition === "before" && icon}
      {children}
      {iconPosition === "after" && icon}
    </button>
  );
}

/* ---------------- inputs ---------------- */
export function Field({ label, required, hint, children, className }: FieldProps) {
  return (
    <div className={cx("field", className)}>
      {label && (
        <label>
          {label}
          {required && <span aria-hidden="true"> *</span>}
        </label>
      )}
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </div>
  );
}

export function Input({
  value,
  onChange,
  contentBefore,
  className,
  ...rest
}: InputProps) {
  const control = (
    <input
      className={cx("input", className)}
      value={value ?? ""}
      onChange={(event) => onChange?.(event, { value: event.target.value })}
      {...rest}
    />
  );
  if (!contentBefore) return control;
  return (
    <div className="input-wrap">
      {contentBefore}
      {control}
    </div>
  );
}

export function Textarea({ value, onChange, className, ...rest }: TextareaProps) {
  return (
    <textarea
      className={cx("textarea", className)}
      value={value ?? ""}
      onChange={(event) => onChange?.(event, { value: event.target.value })}
      {...rest}
    />
  );
}

export function Select({ value, onChange, children, className, ...rest }: SelectProps) {
  return (
    <select
      className={cx("select", className)}
      value={value}
      onChange={(event) => onChange?.(event, { value: event.target.value })}
      {...rest}
    >
      {children}
    </select>
  );
}

export function Checkbox({ checked, onChange, label, className, ...rest }: CheckboxProps) {
  return (
    <label className={cx("checkbox", className)}>
      <input
        type="checkbox"
        checked={!!checked}
        onChange={(event) =>
          onChange?.(event, { checked: event.target.checked })
        }
        {...rest}
      />
      {label && <span>{label}</span>}
    </label>
  );
}

export function Switch({ checked, onChange, label, disabled, className }: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={!!checked}
      aria-label={typeof label === "string" ? label : undefined}
      title={typeof label === "string" ? label : undefined}
      disabled={disabled}
      className={cx("switch", className)}
      onClick={() => onChange?.(null, { checked: !checked })}
    >
      <span className="sr-only" hidden>
        {label}
      </span>
    </button>
  );
}

/* ---------------- badge / tabs / tooltip ---------------- */
export function Badge({ appearance = "filled", color, className, children }: BadgeProps) {
  const tone =
    color === "brand" || color === "informative"
      ? "badge--informative"
      : color === "success"
        ? "badge--success"
        : color === "warning" || color === "severe"
          ? "badge--warning"
          : color === "danger" || color === "important"
            ? "badge--danger"
            : undefined;
  return (
    <span
      className={cx(
        "badge",
        appearance === "tint" && "badge--tint",
        tone,
        className,
      )}
    >
      {children}
    </span>
  );
}

const TabContext = createContext<{
  selected?: string;
  onSelect?: (value: string) => void;
}>({});

export function TabList({ selectedValue, onTabSelect, children, className }: TabListProps) {
  const value = useMemo(
    () => ({
      selected: selectedValue,
      onSelect: (next: string) => onTabSelect?.(null, { value: next }),
    }),
    [selectedValue, onTabSelect],
  );
  return (
    <div role="tablist" className={cx("tabs", className)}>
      <TabContext.Provider value={value}>{children}</TabContext.Provider>
    </div>
  );
}

export function Tab({ value, icon, children }: TabProps) {
  const { selected, onSelect } = useContext(TabContext);
  return (
    <button
      type="button"
      role="tab"
      aria-selected={selected === value}
      className="tab"
      onClick={() => onSelect?.(value)}
    >
      {icon}
      {children}
    </button>
  );
}

export function Tooltip({ content, children, className }: TooltipProps) {
  return (
    <span className={cx("tip", className)}>
      {children}
      <span className="tip__content" role="tooltip">
        {content}
      </span>
    </span>
  );
}

export function Spinner({ label, size }: SpinnerProps) {
  return (
    <span className="spinner" data-size={size}>
      {label || "加载中…"}
    </span>
  );
}

/* ---------------- dialog ---------------- */
const DialogContext = createContext<{ close: () => void }>({ close: () => {} });

export function Dialog({ open, onOpenChange, children }: DialogProps) {
  const close = useCallback(() => {
    onOpenChange?.(null, { open: false });
  }, [onOpenChange]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, close]);

  if (!open) return null;
  return (
    <DialogContext.Provider value={{ close }}>
      <div
        className="dialog-backdrop"
        onMouseDown={(event) => {
          if (event.target === event.currentTarget) close();
        }}
      >
        {children}
      </div>
    </DialogContext.Provider>
  );
}

export function DialogSurface({ className, children }: Any) {
  return (
    <div
      className={cx("dialog", className)}
      role="dialog"
      aria-modal="true"
      onMouseDown={(event) => event.stopPropagation()}
    >
      {children}
    </div>
  );
}

export function DialogBody({ children }: Any) {
  return <div className="dialog__inner">{children}</div>;
}

export function DialogTitle({ children }: Any) {
  return <div className="dialog__title">{children}</div>;
}

export function DialogContent({ children }: Any) {
  return <div className="dialog__body">{children}</div>;
}

export function DialogActions({ children }: Any) {
  return <div className="dialog__actions">{children}</div>;
}

export function MessageBar(_: Any) {
  return null;
}

export { cx };
