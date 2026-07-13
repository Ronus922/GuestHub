"use server";

import { revalidatePath } from "next/cache";
import type { ActionResult } from "@/app/(dashboard)/calendar/types";
import { getActor, AuthorizationError } from "@/lib/auth/actor";
import {
  CheckInCheckOutValidationError,
  saveCheckInCheckOutSettingsCore,
} from "@/lib/check-in-check-out-mutation";
import {
  type CheckInCheckOutSettings,
} from "@/lib/check-in-check-out";
import { sql } from "@/lib/db";

export async function saveCheckInCheckOutSettingsAction(
  raw: unknown,
): Promise<ActionResult<CheckInCheckOutSettings>> {
  try {
    const actor = await getActor();
    const saved = await saveCheckInCheckOutSettingsCore({ actor, raw, db: sql });

    revalidatePath("/settings");
    return { success: true, data: saved };
  } catch (error) {
    if (error instanceof AuthorizationError || error instanceof CheckInCheckOutValidationError) {
      return { success: false, error: error.message };
    }
    console.error("[settings:check-in-check-out]", error);
    return { success: false, error: "אירעה שגיאה בלתי צפויה" };
  }
}
