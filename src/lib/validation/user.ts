import { z } from "zod";

const username = z
  .string()
  .trim()
  .min(3, "שם משתמש חייב 3 תווים לפחות")
  .max(50, "שם משתמש ארוך מדי")
  .regex(/^[a-zA-Z0-9._-]+$/, "אותיות באנגלית, ספרות, . _ - בלבד");

const fullName = z.string().trim().min(2, "יש להזין שם מלא").max(120);
const email = z.string().trim().toLowerCase().pipe(z.email("אימייל לא תקין"));
const phone = z.string().trim().min(7, "יש להזין טלפון").max(30);
const roleId = z.string().uuid("יש לבחור תפקיד");
const password = z
  .string()
  .min(8, "סיסמה באורך 8 תווים לפחות")
  .max(72, "סיסמה ארוכה מדי");

// Create: email is always required (the auth identity + username→email login both
// need it — see DECISIONS D21). Username/password are required only when the
// username+password login method is enabled; otherwise the username is derived
// server-side from the email and no password is set.
export const createUserSchema = z
  .object({
    full_name: fullName,
    email,
    phone,
    role_id: roleId,
    allow_google_auth: z.boolean(),
    enable_userpass: z.boolean(),
    username: username.optional().or(z.literal("")),
    password: password.optional().or(z.literal("")),
    is_active: z.boolean().default(true),
  })
  .superRefine((v, ctx) => {
    if (!v.allow_google_auth && !v.enable_userpass)
      ctx.addIssue({ code: "custom", path: ["enable_userpass"], message: "יש לבחור לפחות אופן התחברות אחד" });
    if (v.enable_userpass && !v.username)
      ctx.addIssue({ code: "custom", path: ["username"], message: "יש להזין שם משתמש" });
    if (v.enable_userpass && !v.password)
      ctx.addIssue({ code: "custom", path: ["password"], message: "יש להזין סיסמה ראשונית" });
  });

export const updateUserSchema = z.object({
  id: z.string().uuid(),
  full_name: fullName,
  username,
  email,
  phone: phone.optional().or(z.literal("")),
  role_id: roleId,
  allow_google_auth: z.boolean(),
  is_active: z.boolean(),
  // optional password reset on edit
  new_password: password.optional().or(z.literal("")),
});

export const setActiveSchema = z.object({
  id: z.string().uuid(),
  is_active: z.boolean(),
});

// Full desired-state vector of the employee's effective matrix. The server diffs
// it against role defaults + existing override rows, so redundant rows never
// persist (checked === role default ⇒ the override row is deleted).
export const saveOverridesSchema = z.object({
  user_id: z.string().uuid(),
  entries: z
    .array(
      z.object({
        key: z.string().min(1).max(100),
        checked: z.boolean(),
      }),
    )
    .max(500),
});

export const togglePermissionSchema = z.object({
  role_id: z.string().uuid(),
  permission_id: z.string().uuid(),
  granted: z.boolean(),
});

export type CreateUserInput = z.infer<typeof createUserSchema>;
export type UpdateUserInput = z.infer<typeof updateUserSchema>;

// ---- client form schemas (react-hook-form). Non-optional strings play nicely with
//      RHF; empty optional values are normalized server-side. ----
const fFull = z.string().trim().min(2, "יש להזין שם מלא").max(120);
const fUser = z
  .string()
  .trim()
  .max(50)
  .regex(/^[a-zA-Z0-9._-]*$/, "אותיות באנגלית, ספרות, . _ - בלבד");
const fEmail = z.string().trim().min(1, "יש להזין אימייל").pipe(z.email("אימייל לא תקין"));
const fPhone = z.string().trim().min(7, "יש להזין טלפון").max(30);
const fRole = z.string().min(1, "יש לבחור תפקיד");

const formShape = {
  full_name: fFull,
  email: fEmail,
  phone: fPhone,
  role_id: fRole,
  allow_google_auth: z.boolean(),
  enable_userpass: z.boolean(),
  username: fUser,
  password: z.string().max(72),
  is_active: z.boolean(),
};

const loginMethodRules = (v: {
  allow_google_auth: boolean;
  enable_userpass: boolean;
  username: string;
  password: string;
}, ctx: z.RefinementCtx, passwordRequired: boolean) => {
  if (!v.allow_google_auth && !v.enable_userpass)
    ctx.addIssue({ code: "custom", path: ["enable_userpass"], message: "יש לבחור לפחות אופן התחברות אחד" });
  if (v.enable_userpass && v.username.trim().length < 3)
    ctx.addIssue({ code: "custom", path: ["username"], message: "שם משתמש 3 תווים לפחות" });
  // Stale values in the hidden credentials box must not block submission —
  // they are cleared before send when the method is off.
  if (v.enable_userpass && passwordRequired && v.password.length < 8)
    ctx.addIssue({ code: "custom", path: ["password"], message: "סיסמה באורך 8 תווים לפחות" });
  if (v.enable_userpass && v.password.length > 0 && v.password.length < 8)
    ctx.addIssue({ code: "custom", path: ["password"], message: "סיסמה באורך 8 תווים לפחות" });
};

export const createFormSchema = z
  .object(formShape)
  .superRefine((v, ctx) => loginMethodRules(v, ctx, true));

// Edit: username always present (every stored user has one); password optional reset.
export const editFormSchema = z
  .object(formShape)
  .superRefine((v, ctx) => {
    if (v.username.trim().length < 3)
      ctx.addIssue({ code: "custom", path: ["username"], message: "שם משתמש 3 תווים לפחות" });
    if (v.password.length > 0 && v.password.length < 8)
      ctx.addIssue({ code: "custom", path: ["password"], message: "סיסמה באורך 8 תווים לפחות" });
  });

export type EmployeeFormValues = z.infer<typeof createFormSchema>;
