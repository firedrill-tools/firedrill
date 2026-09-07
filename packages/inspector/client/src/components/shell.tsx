import {
  Activity,
  Database,
  FileStack,
  FlaskConical,
  Globe,
  Menu,
  Moon,
  RefreshCw,
  Sun,
  TestTubeDiagonal,
  Users,
  Wrench,
  X,
} from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import type { Route, SimulationProject } from "../types";
import { IconButton } from "./primitives";

const navigation: ReadonlyArray<{
  readonly id: string;
  readonly label: string;
  readonly items: ReadonlyArray<{
    readonly route: Route;
    readonly label: string;
    readonly icon: typeof Database;
  }>;
}> = [
  {
    id: "world",
    label: "World",
    items: [
      { route: "/world", label: "Synthetic world", icon: Globe },
      { route: "/schema", label: "Schema", icon: FileStack },
      { route: "/data", label: "Data", icon: Database },
      { route: "/tools", label: "Tools", icon: Wrench },
      { route: "/personas", label: "Personas & actors", icon: Users },
    ],
  },
  {
    id: "testing",
    label: "Testing",
    items: [
      { route: "/scenarios", label: "Scenarios", icon: FlaskConical },
      { route: "/drills", label: "Drills", icon: TestTubeDiagonal },
      { route: "/runs", label: "Runs", icon: Activity },
    ],
  },
];

function storedTheme(): "light" | "dark" {
  const value = localStorage.getItem("firedrill-inspector-theme");
  if (value === "light" || value === "dark") return value;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function AppShell({
  route,
  project,
  refreshing,
  onNavigate,
  onRefresh,
  children,
}: {
  readonly route: Route;
  readonly project: SimulationProject;
  readonly refreshing: boolean;
  readonly onNavigate: (route: Route) => void;
  readonly onRefresh: () => void;
  readonly children: ReactNode;
}) {
  const [theme, setTheme] = useState<"light" | "dark">(storedTheme);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [compact, setCompact] = useState(() => window.matchMedia("(max-width: 1023px)").matches);
  useEffect(() => {
    const query = window.matchMedia("(max-width: 1023px)");
    const update = () => {
      setCompact(query.matches);
      if (!query.matches) setMobileOpen(false);
    };
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("firedrill-inspector-theme", theme);
  }, [theme]);

  const navigate = (next: Route) => {
    setMobileOpen(false);
    onNavigate(next);
  };

  return (
    <div className="fd-app-shell">
      <header className="fd-appbar">
        <IconButton
          id="inspector-nav-toggle"
          className="fd-mobile-menu"
          label={mobileOpen ? "Close navigation" : "Open navigation"}
          aria-expanded={mobileOpen}
          aria-controls="inspector-sidebar"
          onClick={() => setMobileOpen((value) => !value)}
        >
          {mobileOpen ? <X size={19} /> : <Menu size={19} />}
        </IconButton>
        <img className="fd-logo fd-logo--light" src="/brand/firedrill-logo.svg" alt="Firedrill" />
        <img className="fd-logo fd-logo--dark" src="/brand/firedrill-logo-dark.svg" alt="Firedrill" />
        <div className="fd-appbar__divider" />
        <div className="fd-project-identity">
          <Database size={16} aria-hidden="true" />
          <span>{project.world.title ?? project.world.id}</span>
        </div>
        <div className="fd-appbar__actions">
          <IconButton label="Refresh repository source" onClick={onRefresh} disabled={refreshing}>
            <RefreshCw className={refreshing ? "fd-spin" : ""} size={17} />
          </IconButton>
          <IconButton
            label={theme === "light" ? "Use dark theme" : "Use light theme"}
            onClick={() => setTheme((value) => (value === "light" ? "dark" : "light"))}
          >
            {theme === "light" ? <Moon size={17} /> : <Sun size={17} />}
          </IconButton>
        </div>
      </header>
      <div className="fd-shell-body">
        {mobileOpen ? (
          <button
            type="button"
            className="fd-nav-scrim"
            aria-label="Close navigation"
            onClick={() => setMobileOpen(false)}
          />
        ) : null}
        <aside
          id="inspector-sidebar"
          className="fd-sidebar"
          data-open={mobileOpen || undefined}
          inert={compact && !mobileOpen}
          onKeyDown={(event) => {
            if (event.key === "Escape" && compact && mobileOpen) {
              setMobileOpen(false);
              document.getElementById("inspector-nav-toggle")?.focus();
            }
          }}
        >
          <nav aria-label="Local inspector">
            {navigation.map((group) => (
              <section className="fd-nav-group" key={group.id} aria-labelledby={`nav-${group.id}`}>
                <h2 id={`nav-${group.id}`} className="fd-sidebar__label">
                  {group.label}
                </h2>
                {group.items.map((item) => {
                  const Icon = item.icon;
                  return (
                    <button
                      type="button"
                      key={item.route}
                      className="fd-nav-item"
                      aria-current={route === item.route ? "page" : undefined}
                      onClick={() => navigate(item.route)}
                    >
                      <Icon size={18} aria-hidden="true" />
                      <span>{item.label}</span>
                    </button>
                  );
                })}
              </section>
            ))}
          </nav>
        </aside>
        <main className="fd-main">{children}</main>
      </div>
    </div>
  );
}
