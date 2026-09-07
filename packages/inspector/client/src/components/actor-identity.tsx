import type { SimulationSetup } from "../types";
import "./actor-identity.css";

export function ActorIdentity({ actor }: { readonly actor: SimulationSetup["actors"][number] }) {
  return (
    <div className="fd-actor-identity">
      <code>{actor.id}</code>
      {actor.description === undefined ? null : (
        <p className="fd-actor-identity__description">{actor.description}</p>
      )}
    </div>
  );
}
