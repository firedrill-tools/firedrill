import { processSample, reserveSlot, setTemperature } from "./native-clients.js";

// These application entry points have no Firedrill imports, bindings, or test mode.
export async function bookAppointment(slotId: string, customerId: string): Promise<string> {
  const reserved = await reserveSlot(slotId, customerId);
  return reserved ? "Appointment booked" : "No slot available";
}

export function stabilizeRoom(roomId: string): string {
  try {
    const actual = setTemperature(roomId, 22);
    return actual === 22 ? "Temperature restored" : "Controller needs review";
  } catch (error) {
    if (error instanceof Error && error.message === "Controller offline") return "Escalate to operator";
    throw error;
  }
}

export async function finishSample(sampleId: string): Promise<string> {
  const status = await processSample(sampleId);
  return status === "processed" ? "Ready for review" : "Not processed";
}
