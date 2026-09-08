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
    title: "Starting data",
    description:
      "Starting records from source. See live changes in State & activity and saved drill outcomes in Results.",
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
      "A drill gives your agent a task in a controlled environment and checks the outcome. See saved outcomes in Results.",
  },
  runs: {
    title: "Results",
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
