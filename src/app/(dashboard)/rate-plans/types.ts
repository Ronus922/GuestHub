// Client-shared types for the Rate Plans module. Server types re-exported from
// the service so the screen, wizard and simulator share one vocabulary.

import type { AssignableUnit, RatePlanListItem } from "@/lib/rate-plans/service";

export type PolicyOption = { id: string; name: string; is_active: boolean };

export type RatePlansCan = {
  create: boolean;
  edit: boolean;
  del: boolean;
  simulate: boolean;
};

export type { AssignableUnit, RatePlanListItem };
