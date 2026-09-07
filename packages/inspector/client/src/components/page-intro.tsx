const pages = {
  world: {
    title: "Synthetic world",
    description:
      "A world is a synthetic environment with the data, tools, and situations your agent encounters during a test.",
  },
  schema: {
    title: "Schema",
    description:
      "The record structures your synthetic tools declare: fields, types, and constraints. These describe the fake services, not your agent’s own database.",
  },
  data: {
    title: "Data",
    description:
      "The synthetic records a drill starts with. Choose the world baseline or a scenario; changes made during execution are shown under Runs.",
  },
  personas: {
    title: "Personas & actors",
    description:
      "The identities in your synthetic world, their attributes, and the tools each may use. These are the actors declared in your source files.",
  },
  scenarios: {
    title: "Scenarios",
    description:
      "A scenario sets the starting situation: data, identities, faults, and scheduled events. A drill adds an agent task and checks to that situation.",
  },
  tools: {
    title: "Synthetic tools",
    description:
      "The fake services your agent can call. Inspect their inputs, responses, and stored data; behavior is defined by your repository’s tool code.",
  },
  drills: {
    title: "Drills",
    description: "A drill is a test that gives your agent a task and checks its actions and results.",
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
