import { toast } from "sonner";

// D188 — the Group Update result on the ONE system toast (Shell.tsx <Toaster>:
// bottom-centre, ink surface, 2.8s): "עודכנו N תאים · M שונו". N = cells the
// run targeted, M = cells whose price OR any restriction actually changed (D187).
// M === 0 is the danger variant and does not auto-dismiss — it stays until its X
// is pressed: the operator asked for a change and nothing moved, so the values
// need a second look before the panel's silent close hides that.
export function showGroupUpdateResultToast(cells: number, changed: number): void {
  if (changed === 0) {
    toast.error(`עודכנו ${cells} תאים · 0 שונו — בדוק את הערכים`, {
      duration: Infinity,
      closeButton: true,
    });
    return;
  }
  toast.success(`עודכנו ${cells} תאים · ${changed} שונו`);
}
