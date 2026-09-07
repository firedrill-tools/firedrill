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
import { compactId } from "../format";
import type { Route, SimulationProject } from "../types";
import { IconButton } from "./primitives";

const navigation: ReadonlyArray<{
  readonly route: Route;
  readonly label: string;
  readonly icon: typeof Database;
}> = [
  { route: "/world", label: "Synthetic world", icon: Globe },
  { route: "/schema", label: "Schema", icon: FileStack },
  { route: "/data", label: "Data", icon: Database },
  { route: "/personas", label: "Personas & actors", icon: Users },
  { route: "/scenarios", label: "Scenarios", icon: FlaskConical },
  { route: "/tools", label: "Tools", icon: Wrench },
  { route: "/drills", label: "Drills", icon: TestTubeDiagonal },
  { route: "/runs", label: "Runs", icon: Activity },
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
          className="fd-mobile-menu"
          label={mobileOpen ? "Close navigation" : "Open navigation"}
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
        <div className="fd-appbar__build" title={project.world.buildHash}>
          Build <code>{compactId(project.world.buildHash, 13)}</code>
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
        <aside className="fd-sidebar" data-open={mobileOpen || undefined}>
          <nav aria-label="Local inspector">
            <div className="fd-sidebar__label">Inspect</div>
            {navigation.map((item) => {
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
          </nav>
          <div className="fd-sidebar__foot">
            <span>Local</span>
            <span className="fd-local-dot" />
            <span>No account</span>
          </div>
        </aside>
        <main className="fd-main">{children}</main>
      </div>
    </div>
  );
}
