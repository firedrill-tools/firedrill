const pages = {
  world: {
    title: "World",
    description:
      "A world is a synthetic environment with the data, tools, and situations your agent encounters during a test.",
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
