import { mockModel, mockWhatsAppCloud, tmpProject, type ModelStep } from "@wappy/testkit";

/**
 * Spine harness: temp project + mock WhatsApp Cloud + mock model.
 * Later milestones plug the real runtime in here; only the CLI/e2e may wire parts together.
 */
export async function createSpine(script: ModelStep[] = []) {
  const project = tmpProject();
  const whatsapp = await mockWhatsAppCloud();
  const model = mockModel(script);
  return {
    project,
    whatsapp,
    model,
    async close() {
      await whatsapp.close();
      project.cleanup();
    },
  };
}
