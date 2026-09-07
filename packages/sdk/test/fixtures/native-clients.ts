/** Ordinary application dependencies. Test code, not agents, replaces these. */
export async function reserveSlot(slotId: string, customerId: string): Promise<boolean> {
  throw new Error(`Scheduling client is not configured for ${slotId}/${customerId}`);
}

export function setTemperature(roomId: string, celsius: number): number {
  throw new Error(`Controller is not configured for ${roomId}/${celsius}`);
}

export async function processSample(sampleId: string): Promise<string> {
  throw new Error(`Sample client is not configured for ${sampleId}`);
}
