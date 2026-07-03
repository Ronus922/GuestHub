"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useForm, Controller, type Resolver, type FieldErrors } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import { SidePanel } from "@/components/ui/SidePanel";
import { Tabs } from "@/components/ui/Tabs";
import { Icon, type IconName } from "@/components/shared/Icon";
import { canAssignRole, canManageTarget } from "@/lib/auth/guards";
import {
  createFormSchema,
  editFormSchema,
  type EmployeeFormValues,
} from "@/lib/validation/user";
import {
  createUserAction,
  updateUserAction,
  saveUserPermissionOverridesAction,
} from "./actions";
import { PermissionsByModule } from "./PermissionsByModule";
import { roleMeta, AVATAR_TINT } from "./role-meta";
import type {
  StaffUser,
  RoleOption,
  RolePermissionsMap,
  PermissionDef,
  UserOverride,
} from "./types";

const FULL_ACCESS_ROLES = new Set(["super_admin", "admin"]);

// Reference (employee-permissions-screen.png) tabs are פרופיל/דיווח/הרשאות/…;
// only tabs with a real backing model exist — no dead placeholders. הרשאות is
// internal: role selection + the effective per-module matrix, never /permissions.
type EditTab = "details" | "access" | "permissions";

const EDIT_TABS: { value: EditTab; label: string }[] = [
  { value: "details", label: "פרופיל" },
  { value: "access", label: "התחברות וגישה" },
  { value: "permissions", label: "הרשאות" },
];

// Which tab owns each form field — used to jump to the first tab with an error.
const TAB_OF_FIELD: Record<string, EditTab> = {
  full_name: "details",
  phone: "details",
  email: "details",
  allow_google_auth: "access",
  enable_userpass: "access",
  username: "access",
  password: "access",
  is_active: "access",
  role_id: "permissions",
};

export function EmployeeSidePanel({
  open,
  mode,
  user,
  roles,
  rolePermissions,
  permissionCatalog,
  overrides,
  currentUserId,
  actorRoleKey,
  canDisable,
  canViewPermissions,
  canManageOverrides,
  onClose,
  onSaved,
}: {
  open: boolean;
  mode: "create" | "edit";
  user?: StaffUser;
  roles: RoleOption[];
  rolePermissions: RolePermissionsMap;
  permissionCatalog: PermissionDef[];
  overrides: UserOverride[];
  currentUserId: string;
  actorRoleKey: string;
  canDisable: boolean;
  canViewPermissions: boolean;
  canManageOverrides: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [tab, setTab] = useState<EditTab>("details");
  const gActor = { userId: currentUserId, roleKey: actorRoleKey };
  const isSelf = mode === "edit" && user?.id === currentUserId;
  const isProtected =
    mode === "edit" &&
    !!user &&
    !canManageTarget(gActor, { id: user.id, roleKey: user.role_key });
  // Server enforces the same rule (canAssignRole) — this only hides dead options.
  // A protected target's actual role is still shown (read-only) so the panel
  // never misrepresents it as "none selected".
  const assignableRoles = roles.filter(
    (r) =>
      canAssignRole(gActor, r.key).ok ||
      (mode === "edit" && user?.role_id === r.id),
  );

  const {
    register,
    handleSubmit,
    control,
    reset,
    watch,
    formState: { errors, isSubmitting },
  } = useForm<EmployeeFormValues>({
    resolver: zodResolver(
      mode === "create" ? createFormSchema : editFormSchema,
    ) as Resolver<EmployeeFormValues>,
    defaultValues: {
      full_name: "",
      email: "",
      phone: "",
      role_id: "",
      allow_google_auth: true,
      enable_userpass: true,
      username: "",
      password: "",
      is_active: true,
    },
  });

  // Locally staged override edits: permission key → desired checked state.
  // Persisted (as real user_permission_overrides rows) only on save.
  const [staged, setStaged] = useState<Record<string, boolean>>({});

  useEffect(() => {
    if (!open) return;
    setTab("details");
    setStaged({});
    if (mode === "edit" && user) {
      reset({
        full_name: user.full_name ?? "",
        email: user.email ?? "",
        phone: user.phone ?? "",
        role_id: user.role_id ?? "",
        allow_google_auth: user.allow_google_auth,
        enable_userpass: true,
        username: user.username,
        password: "",
        is_active: user.is_active,
      });
    } else {
      reset({
        full_name: "",
        email: "",
        phone: "",
        role_id: assignableRoles.find((r) => r.key === "receptionist")?.id ?? "",
        allow_google_auth: true,
        enable_userpass: true,
        username: "",
        password: "",
        is_active: true,
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, mode, user]);

  const selectedRoleId = watch("role_id");
  const userpassOn = mode === "create" ? watch("enable_userpass") : true;
  const selectedRole = roles.find((r) => r.id === selectedRoleId);
  const grantedKeys = useMemo(
    () => new Set((selectedRoleId ? (rolePermissions[selectedRoleId] ?? []) : []).map((p) => p.key)),
    [selectedRoleId, rolePermissions],
  );

  // Server resolution mirrored locally: role default → saved override row → staged
  // edit. The matrix recalculates live against the role selected in the form.
  const overrideMap = useMemo(
    () => new Map(overrides.map((o) => [o.key, o.effect])),
    [overrides],
  );
  const effectiveOf = (key: string): boolean => {
    if (key in staged) return staged[key];
    const eff = overrideMap.get(key);
    if (eff) return eff === "grant";
    return grantedKeys.has(key);
  };
  const effectiveKeys = useMemo(
    () => new Set(permissionCatalog.filter((p) => effectiveOf(p.key)).map((p) => p.key)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [permissionCatalog, staged, overrideMap, grantedKeys],
  );
  const hasPersonal = permissionCatalog.some(
    (p) => effectiveKeys.has(p.key) !== grantedKeys.has(p.key),
  );
  // anything staged that differs from the saved rows (under the selected role)?
  const overridesDirty = Object.entries(staged).some(([key, want]) => {
    const eff = overrideMap.get(key);
    const saved = eff ? eff === "grant" : grantedKeys.has(key);
    return want !== saved;
  });

  const onSubmit = handleSubmit(
    async (values) => {
      const res =
        mode === "create"
          ? await createUserAction({
              full_name: values.full_name,
              email: values.email,
              phone: values.phone,
              role_id: values.role_id,
              allow_google_auth: values.allow_google_auth,
              enable_userpass: values.enable_userpass,
              // stale values from the hidden credentials box are never sent
              username: values.enable_userpass ? values.username : "",
              password: values.enable_userpass ? values.password : "",
              is_active: values.is_active,
            })
          : await updateUserAction({
              id: user!.id,
              full_name: values.full_name,
              username: values.username,
              email: values.email,
              phone: values.phone,
              role_id: values.role_id,
              allow_google_auth: values.allow_google_auth,
              is_active: values.is_active,
              new_password: values.password,
            });
      if (!res.success) {
        toast.error(res.error ?? "הפעולה נכשלה");
        return; // failed validation/guard — the panel stays open
      }
      // Persist staged permission overrides as real rows — the server derives
      // grant/revoke/delete per key from the desired effective matrix.
      if (mode === "edit" && user && canManageOverrides && overridesDirty) {
        const ovRes = await saveUserPermissionOverridesAction({
          user_id: user.id,
          entries: permissionCatalog.map((p) => ({
            key: p.key,
            checked: effectiveOf(p.key),
          })),
        });
        if (!ovRes.success) {
          toast.error(ovRes.error ?? "שמירת ההרשאות האישיות נכשלה");
          return; // profile saved; overrides rejected — stay open for another try
        }
      }
      toast.success(mode === "create" ? "העובד נוצר בהצלחה" : "פרטי העובד עודכנו");
      onSaved();
    },
    (errs: FieldErrors<EmployeeFormValues>) => {
      // Jump to the first tab that contains a validation error (edit is tabbed).
      if (mode !== "edit") return;
      const order: EditTab[] = ["details", "access", "permissions"];
      const first = order.find((t) =>
        Object.keys(errs).some((f) => TAB_OF_FIELD[f] === t),
      );
      if (first) setTab(first);
    },
  );

  /* ---------- shared sections ---------- */

  const detailsSection = (
    <Card title="פרטי העובד" icon="employees">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="שם מלא" required error={errors.full_name?.message}>
          <IconField icon="user">
            <input
              className="field ps-11"
              {...register("full_name")}
              placeholder="שם פרטי ומשפחה"
            />
          </IconField>
        </Field>
        <Field label="טלפון" required error={errors.phone?.message}>
          <IconField icon="phone">
            <input
              className="field ps-11"
              dir="ltr"
              {...register("phone")}
              placeholder="050-0000000"
            />
          </IconField>
        </Field>
      </div>
      <Field
        label="אימייל"
        required
        error={errors.email?.message}
        hint="משמש להתחברות — עם Google או עם שם משתמש וסיסמה."
      >
        <IconField icon="mail">
          <input
            className="field ps-11"
            dir="ltr"
            {...register("email")}
            placeholder="email@example.com"
          />
        </IconField>
      </Field>
    </Card>
  );

  const accessSection = (
    <Card title="אופן התחברות" icon="key">
      <Controller
        control={control}
        name="allow_google_auth"
        render={({ field }) => (
          <CheckRow
            checked={field.value}
            onChange={field.onChange}
            title="אפשר התחברות עם Google"
            desc="העובד יוכל להתחבר בלחיצה על „התחבר עם Google״ — צריך רק אימייל. (חיבור Google יופעל בשלב מאוחר יותר)"
          />
        )}
      />
      {mode === "create" ? (
        <Controller
          control={control}
          name="enable_userpass"
          render={({ field }) => (
            <CheckRow
              checked={field.value}
              onChange={field.onChange}
              title="אפשר התחברות עם שם משתמש וסיסמה"
              desc="מנהל קובע שם משתמש וסיסמה — הדרך הפעילה כיום להתחבר למערכת."
            />
          )}
        />
      ) : null}
      {errors.enable_userpass?.message ? (
        <p className="text-xs text-status-danger">{errors.enable_userpass.message}</p>
      ) : null}

      {userpassOn ? (
        <div className="rounded-xl border border-line bg-appbg/60 p-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="שם משתמש" required error={errors.username?.message}>
              <IconField icon="user">
                <input
                  className="field ps-11"
                  dir="ltr"
                  {...register("username")}
                  placeholder="לדוגמה: mor2026"
                />
              </IconField>
            </Field>
            <Field
              label={mode === "create" ? "סיסמה ראשונית" : "איפוס סיסמה"}
              required={mode === "create"}
              error={errors.password?.message}
            >
              <PasswordInput register={register("password")} />
            </Field>
          </div>
          <p className="mt-2 text-xs text-faint">
            {mode === "create"
              ? "הסיסמה לא תוצג שוב לאחר היצירה — מומלץ להעביר לעובד באופן מאובטח."
              : "השאר ריק כדי לא לשנות את הסיסמה הקיימת."}
          </p>
        </div>
      ) : null}
    </Card>
  );

  const statusSection = (
    <Controller
      control={control}
      name="is_active"
      render={({ field }) => (
        <Switch
          label="חשבון פעיל"
          hint={
            isSelf
              ? "לא ניתן להשבית את המשתמש שלך"
              : "משתמש מושבת מנותק מיד ולא יכול להתחבר"
          }
          checked={field.value}
          disabled={isSelf || (mode === "edit" && !canDisable)}
          onChange={field.onChange}
        />
      )}
    />
  );

  const roleSection = (
    <Card title="תפקיד" icon="shield-check">
      <Controller
        control={control}
        name="role_id"
        render={({ field }) => (
          <div className="flex flex-col gap-2" role="radiogroup" aria-label="תפקיד">
            {assignableRoles.map((r) => (
              <RoleCard
                key={r.id}
                role={r}
                selected={field.value === r.id}
                disabled={isSelf || isProtected}
                onSelect={() => field.onChange(r.id)}
              />
            ))}
          </div>
        )}
      />
      {errors.role_id?.message ? (
        <p className="text-xs text-status-danger">{errors.role_id.message}</p>
      ) : null}
      {isSelf ? (
        <p className="text-xs text-faint">לא ניתן לשנות את התפקיד של עצמך</p>
      ) : null}
    </Card>
  );

  // Effective permissions = role defaults + personal overrides (staged edits
  // included). The matrix follows role changes live, before save. Editable only
  // for authorized admins on an existing, non-protected, non-self employee.
  const selectedFullAccess = !!selectedRole && FULL_ACCESS_ROLES.has(selectedRole.key);
  const overridesEditable =
    mode === "edit" &&
    !!user &&
    canManageOverrides &&
    !isProtected &&
    !isSelf &&
    !selectedFullAccess;
  const matrixSection = (
    <Card
      title="הרשאות לפי מודול"
      icon="permissions"
      action={
        overridesEditable && hasPersonal ? (
          <button
            type="button"
            onClick={() =>
              // stage everything back to the role default — save deletes the rows
              setStaged(
                Object.fromEntries(
                  permissionCatalog.map((p) => [p.key, grantedKeys.has(p.key)]),
                ),
              )
            }
            className="flex h-11 items-center gap-1.5 rounded-lg px-3 text-xs font-medium text-primary hover:bg-primary-050"
          >
            <Icon name="refresh" size={14} />
            אפס לברירת המחדל של התפקיד
          </button>
        ) : undefined
      }
    >
      {selectedRole ? (
        <>
          <p className="-mt-2 text-xs text-faint">
            {overridesEditable
              ? `ברירת המחדל נגזרת מהתפקיד (${selectedRole.name}); סימון או ביטול תא יוצר הרשאה אישית לעובד זה בלבד. השינויים נשמרים בלחיצה על שמירת שינויים.`
              : `הרשאות בתוקף הנגזרות מהתפקיד שנבחר (${selectedRole.name}) וכן הרשאות אישיות אם קיימות. שינוי התפקיד למעלה מעדכן את הטבלה מיידית; ההרשאות ייכנסו לתוקף בשמירה.`}
          </p>
          {selectedFullAccess ? (
            <p className="rounded-xl bg-primary-050 px-4 py-3 text-sm font-medium text-primary">
              גישה מלאה לכל המערכת — {selectedRole.name}. אין צורך בהרשאות אישיות.
            </p>
          ) : null}
          <PermissionsByModule
            catalog={permissionCatalog}
            effectiveKeys={effectiveKeys}
            roleKeys={grantedKeys}
            fullAccess={selectedFullAccess}
            editable={overridesEditable}
            onToggle={(keys, next) =>
              setStaged((prev) => ({
                ...prev,
                ...Object.fromEntries(keys.map((k) => [k, next])),
              }))
            }
          />
          <p className="text-xs text-faint">
            סימון מלא — כל פעולות העמודה במודול · סימון חלקי (־) — חלק מהפעולות, ריחוף מציג
            פירוט.{" "}
            {mode === "edit" && !canManageOverrides
              ? "ההרשאות מוענקות מהתפקיד — רק מנהל מורשה יכול להוסיף או להסיר הרשאות אישיות לעובד. "
              : null}
            {canViewPermissions ? (
              <Link href="/permissions" className="font-medium text-primary hover:underline">
                עריכת ברירת המחדל של תפקיד — במסך ההרשאות
              </Link>
            ) : null}
          </p>
        </>
      ) : (
        <p className="text-sm text-faint">בחר תפקיד כדי להציג הרשאות.</p>
      )}
    </Card>
  );

  return (
    <SidePanel
      open={open}
      onClose={onClose}
      icon={mode === "create" ? "user-plus" : undefined}
      title={mode === "create" ? "הוספת עובד חדש" : (user?.full_name ?? "עריכת עובד")}
      subtitle={
        mode === "create"
          ? "יצירת משתמש חדש במערכת"
          : (user?.email ?? `@${user?.username ?? ""}`)
      }
      // identity header per the employee-permissions reference: initials avatar
      // with an activity dot + the (live) selected-role chip — all real data
      avatar={
        mode === "edit" && user ? (
          <span className="relative grid h-12 w-12 shrink-0 place-items-center rounded-full bg-white text-base font-bold text-primary">
            {initials(user.full_name, user.username)}
            <span
              aria-hidden
              className={`absolute -bottom-0.5 -start-0.5 h-3.5 w-3.5 rounded-full border-2 border-primary ${
                user.is_active ? "bg-status-success" : "bg-line"
              }`}
            />
          </span>
        ) : undefined
      }
      badge={
        mode === "edit" ? (selectedRole?.name ?? user?.role_name ?? undefined) : undefined
      }
      footer={
        <div className="flex items-center justify-between gap-2">
          <button type="button" className="btn btn-outline" onClick={onClose}>
            ביטול
          </button>
          <button
            type="submit"
            form="employee-form"
            className="btn btn-primary"
            disabled={isSubmitting || isProtected}
          >
            <Icon name={mode === "create" ? "user-plus" : "check"} size={18} />
            {isSubmitting ? "שומר…" : mode === "create" ? "צור עובד" : "שמירת שינויים"}
          </button>
        </div>
      }
    >
      <form id="employee-form" onSubmit={onSubmit} className="flex flex-col gap-5">
        {isProtected ? (
          <p className="rounded-xl bg-status-warning-050 px-4 py-3 text-sm text-status-warning">
            רק בעל דרגה מתאימה יכול לערוך משתמש זה
          </p>
        ) : null}

        {mode === "create" ? (
          <>
            {detailsSection}
            {accessSection}
            {roleSection}
            {matrixSection}
            {statusSection}
          </>
        ) : (
          <>
            <Tabs value={tab} onChange={setTab} tabs={EDIT_TABS} />
            <div className={tab === "details" ? "flex flex-col gap-5" : "hidden"}>
              {detailsSection}
              {user ? (
                // Read-only "מידע נוסף" per the edit reference — only fields the
                // schema actually has (last sign-in from auth.users, join date).
                <Card title="מידע נוסף" icon="info">
                  <div className="grid gap-4 sm:grid-cols-2">
                    <InfoItem label="התחברות אחרונה" value={fmtMoment(user.last_sign_in_at)} />
                    <InfoItem label="הצטרפות" value={fmtMoment(user.created_at)} />
                  </div>
                </Card>
              ) : null}
            </div>
            <div className={tab === "access" ? "flex flex-col gap-5" : "hidden"}>
              {accessSection}
              {statusSection}
            </div>
            {/* internal הרשאות tab per the reference — role cards + effective
                per-module matrix, all inside this SidePanel; never /permissions */}
            <div className={tab === "permissions" ? "flex flex-col gap-5" : "hidden"}>
              {roleSection}
              {matrixSection}
            </div>
          </>
        )}
      </form>
    </SidePanel>
  );
}

/* ---------- read-only info ---------- */

const infoTimeFmt = new Intl.DateTimeFormat("he-IL", {
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "Asia/Jerusalem",
});
const infoDateFmt = new Intl.DateTimeFormat("he-IL", {
  year: "2-digit",
  month: "2-digit",
  day: "2-digit",
  timeZone: "Asia/Jerusalem",
});

function fmtMoment(iso: string | null): string {
  if (!iso) return "לא התחבר";
  const d = new Date(iso);
  return `${infoTimeFmt.format(d)} · ${infoDateFmt.format(d)}`;
}

function InfoItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xs text-faint">{label}</span>
      <span dir="ltr" className="text-end text-sm font-semibold text-ink">
        {value}
      </span>
    </div>
  );
}

/* ---------- building blocks ---------- */

// "Mor Meshulam" → "MM", "מור משולם" → "ממ" — first letter of the first two words.
function initials(name: string | null, username: string): string {
  const parts = (name ?? username).trim().split(/\s+/).slice(0, 2);
  return parts.map((p) => p[0] ?? "").join("").toUpperCase() || "?";
}

function Card({
  title,
  icon,
  action,
  children,
}: {
  title: string;
  icon: IconName;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-line bg-surface p-5 shadow-card">
      <div className="mb-4 flex items-center gap-3">
        <span className="grid h-9 w-9 place-items-center rounded-lg bg-primary-050 text-primary">
          <Icon name={icon} size={18} />
        </span>
        <h3 className="font-bold text-ink">{title}</h3>
        {action ? <span className="ms-auto">{action}</span> : null}
      </div>
      <div className="flex flex-col gap-4">{children}</div>
    </section>
  );
}

function Field({
  label,
  required,
  error,
  hint,
  children,
}: {
  label: string;
  required?: boolean;
  error?: string;
  hint?: string;
  children: React.ReactNode;
}) {
  // The <label> wraps its control (implicit association) so clicking the label
  // focuses the input and AT announces the field name; errors are role="alert".
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-sm font-medium text-text2">
        {label}
        {required ? <span className="ms-1 text-status-danger">*</span> : null}
      </span>
      {children}
      {error ? (
        <span role="alert" className="text-xs text-status-danger">
          {error}
        </span>
      ) : hint ? (
        <span className="text-xs text-faint">{hint}</span>
      ) : null}
    </label>
  );
}

function IconField({ icon, children }: { icon: IconName; children: React.ReactNode }) {
  return (
    <div className="relative">
      {children}
      <Icon
        name={icon}
        size={17}
        className="pointer-events-none absolute start-0 top-1/2 ms-3.5 -translate-y-1/2 text-faint"
      />
    </div>
  );
}

// Login-method row per the rendered reference: leading checkbox, title + description.
function CheckRow({
  checked,
  onChange,
  title,
  desc,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  title: string;
  desc: string;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={`flex w-full items-start gap-3 rounded-xl border px-4 py-3 text-start transition-colors ${
        checked ? "border-primary/30 bg-primary-050" : "border-line bg-surface hover:bg-hover"
      }`}
    >
      <span
        className={`mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-md border ${
          checked ? "border-primary bg-primary text-white" : "border-line bg-surface"
        }`}
      >
        {checked ? <Icon name="check" size={13} strokeWidth={3} /> : null}
      </span>
      <span className="min-w-0">
        <span className="block text-sm font-semibold text-ink">{title}</span>
        <span className="block text-xs text-muted">{desc}</span>
      </span>
    </button>
  );
}

// Role radio-card per the rendered reference: radio, tinted icon, name + description.
function RoleCard({
  role,
  selected,
  disabled,
  onSelect,
}: {
  role: RoleOption;
  selected: boolean;
  disabled?: boolean;
  onSelect: () => void;
}) {
  const meta = roleMeta(role.key);
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      disabled={disabled}
      onClick={onSelect}
      className={`flex w-full items-center gap-3 rounded-xl border px-4 py-3 text-start transition-colors disabled:cursor-default disabled:opacity-60 ${
        selected ? "border-primary bg-primary-050" : "border-line bg-surface hover:bg-hover"
      }`}
    >
      <span
        className={`grid h-5 w-5 shrink-0 place-items-center rounded-full border-2 ${
          selected ? "border-primary" : "border-line"
        }`}
      >
        {selected ? <span className="h-2.5 w-2.5 rounded-full bg-primary" /> : null}
      </span>
      <span
        className={`grid h-10 w-10 shrink-0 place-items-center rounded-xl ${AVATAR_TINT[meta.tone]}`}
      >
        <Icon name={meta.icon} size={19} />
      </span>
      <span className="min-w-0">
        <span className="block text-sm font-bold text-ink">{role.name}</span>
        {role.description ? (
          <span className="block truncate text-xs text-muted">{role.description}</span>
        ) : null}
      </span>
    </button>
  );
}

function Switch({
  label,
  hint,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-xl border border-line bg-surface px-4 py-3">
      <div>
        <p className="text-sm font-medium text-ink">{label}</p>
        {hint ? <p className="text-xs text-faint">{hint}</p> : null}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={`relative h-6 w-11 shrink-0 rounded-full transition-colors before:absolute before:-inset-x-1 before:-inset-y-2.5 before:content-[''] disabled:opacity-50 ${
          checked ? "bg-primary" : "bg-line"
        }`}
      >
        {/* anchored at the inline END (RTL: left) — ON sits at the end, OFF slides
            back toward the start; transform-based so the motion animates */}
        <span
          className={`absolute end-0.5 top-0.5 h-5 w-5 rounded-full bg-white shadow-sm transition-transform ${
            checked ? "translate-x-0" : "translate-x-5"
          }`}
        />
      </button>
    </div>
  );
}

function PasswordInput({
  register,
}: {
  register: ReturnType<ReturnType<typeof useForm<EmployeeFormValues>>["register"]>;
}) {
  const [show, setShow] = useState(false);
  return (
    <div className="relative">
      <input
        className="field ps-11 pe-11"
        dir="ltr"
        type={show ? "text" : "password"}
        autoComplete="new-password"
        placeholder="לפחות 8 תווים"
        {...register}
      />
      <Icon
        name="lock"
        size={17}
        className="pointer-events-none absolute start-0 top-1/2 ms-3.5 -translate-y-1/2 text-faint"
      />
      <button
        type="button"
        onClick={() => setShow((v) => !v)}
        aria-label={show ? "הסתר סיסמה" : "הצג סיסמה"}
        className="absolute end-0 top-1/2 grid h-11 w-11 -translate-y-1/2 place-items-center rounded-lg text-faint hover:text-muted"
      >
        <Icon name={show ? "eye-off" : "eye"} size={18} />
      </button>
    </div>
  );
}
