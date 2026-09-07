const pages = {
  world: {
    title: "Synthetic world",
    description: "The synthetic data and tools your agent interacts with during a drill.",
  },
  schema: {
    title: "Schema",
    description:
      "Fields, types, and constraints for records in your fake services—not your agent’s own database.",
  },
  data: {
    title: "Data",
    description: "Starting records for the world or a scenario. Changes made by the agent appear under Runs.",
  },
  personas: {
    title: "Personas & actors",
    description: "Identities in your world, their attributes, and the tools they may use.",
  },
  scenarios: {
    title: "Scenarios",
    description: "Starting situations for your drills: data, identities, faults, and scheduled events.",
  },
  tools: {
    title: "Synthetic tools",
    description:
      "Fake services your agent can call, with inputs, responses, and behavior defined in your repository.",
  },
  drills: {
    title: "Drills",
    description:
      "A drill simulates an agent task in a starting scenario and checks the outcome. See results under Runs.",
  },
  runs: {
    title: "Runs",
    description:
      "A run records one attempt at a drill. See what your agent did, what changed, and which checks passed.",
  },
} as const;

export function PageIntro({ page }: { readonly page: keyof typeof pages }) {
  const { title, description } = pages[page];
  return (
    <div className="fd-page-intro">
      <h1>{title}</h1>
      <p>{description}</p>
    </div>
  );
}
