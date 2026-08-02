// ============================================================
// <StatusButton> — one control, three states (audit §B.2).
//
// WHY IT EXISTS. DeshbordMain.md §8.4 records the trap: long Hebrew labels in a
// narrow row wrap to two lines and the row's height jumps as the operator works
// down the list. The fix is not per-screen CSS — it is `white-space:nowrap` +
// a uniform `min-width` + `justify-content:center`, applied everywhere the
// control appears. Three windows use it (`arr` check-in/out, `hk` "סמן כנקי",
// `iss` "טופל"), so it is one component and the trap is unrepresentable.
//
// GEOMETRY. Ported from the reference EXCEPT its height: the reference is 34px,
// which is not a control height this system has. It snaps to `.btn-sm` (36px) —
// the app's only small size (GUIDELINES §4).
//
// The `done` state is deliberately NOT a disabled button. A finished action is
// a statement, not a dead control, so it renders as a chip on the §3.1 paid
// triplet and stops being focusable at all.
// ============================================================
import { Icon, type IconName } from "./Icon";

export type StatusButtonState = "primary" | "warn" | "done";

export function StatusButton({
  state,
  label,
  icon,
  onClick,
  disabled,
  title,
}: {
  state: StatusButtonState;
  label: string;
  icon?: IconName;
  onClick?: () => void;
  disabled?: boolean;
  title?: string;
}) {
  if (state === "done") {
    return (
      <span className="chip chip-paid btn-status-done" title={title}>
        {icon && <Icon name={icon} size={13.5} />}
        {label}
      </span>
    );
  }
  return (
    <button
      type="button"
      className={`btn btn-sm btn-status ${state === "warn" ? "btn-warn" : "btn-primary"}`}
      onClick={onClick}
      disabled={disabled}
      title={title}
    >
      {icon && <Icon name={icon} size={17} />}
      {label}
    </button>
  );
}
