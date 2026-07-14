import { redirect } from "next/navigation";
import { getActor, hasPermission } from "@/lib/auth/actor";
import { Icon } from "@/components/shared/Icon";
import { CommunicationsShell, type CommunicationSection } from "@/components/communications/CommunicationsShell";
import { loadPreviewDatasets, propertyOnlyContext } from "@/lib/communications/automation";
import { loadCommunicationsData } from "../data";

const SECTIONS = new Set<CommunicationSection>(["automations", "templates", "history", "channels", "archive"]);

const REQUIRED: Record<CommunicationSection, string> = {
  automations: "communications.automations.manage",
  templates: "communications.templates.view",
  history: "communications.deliveries.view",
  channels: "communications.channels.manage",
  archive: "communications.templates.view",
};

export default async function CommunicationSectionPage({ params }: { params: Promise<{ section: string }> }) {
  const { section: raw } = await params;
  if (!SECTIONS.has(raw as CommunicationSection)) redirect("/communications/templates");
  const section = raw as CommunicationSection;

  const actor = await getActor();
  if (!actor) redirect("/auth/signout");

  if (!hasPermission(actor, REQUIRED[section])) {
    return (
      <main className="gc-page" dir="rtl">
        <section className="card">
          <div className="empty-state">
            <span><Icon name="lock" size={24} /></span>
            <h3 className="empty-t">אין הרשאה למסך הזה</h3>
            <p className="empty-s">פנו למנהל המערכת כדי לקבל את ההרשאה המתאימה.</p>
          </div>
        </section>
      </main>
    );
  }

  const canViewTemplates = hasPermission(actor, "communications.templates.view");
  // The preview datasets are REAL reservations — the guest's email, phone, name,
  // room and balance — and they are serialized to the browser. Editing a template
  // is not a reason to see them: communications.templates.view is its own
  // permission and does not imply reservations.view. Without it the editor
  // previews against the property only, which still proves the template renders.
  const canSeeGuestData = hasPermission(actor, "reservations.view");
  const [data, datasets, fallbackContext] = await Promise.all([
    loadCommunicationsData(actor.tenantId, {
      templates: canViewTemplates,
      automations: hasPermission(actor, "communications.automations.manage"),
      deliveries: hasPermission(actor, "communications.deliveries.view"),
      channels: hasPermission(actor, "communications.channels.manage"),
    }),
    // A preview runs through the very same context builder the worker uses — so a
    // preview cannot look correct while the live send would not.
    canViewTemplates && canSeeGuestData ? loadPreviewDatasets(actor.tenantId) : Promise.resolve([]),
    propertyOnlyContext(actor.tenantId),
  ]);

  return (
    <CommunicationsShell
      section={section}
      data={data}
      datasets={datasets}
      fallbackContext={fallbackContext}
      permissions={{
        editTemplates: hasPermission(actor, "communications.templates.edit"),
        publishTemplates: hasPermission(actor, "communications.templates.publish"),
        testSend: hasPermission(actor, "communications.test.send"),
        manageAutomations: hasPermission(actor, "communications.automations.manage"),
        activateAutomations: hasPermission(actor, "communications.automations.activate"),
        manageChannels: hasPermission(actor, "communications.channels.manage"),
      }}
    />
  );
}
