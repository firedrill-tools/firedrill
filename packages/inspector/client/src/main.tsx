import "@fontsource-variable/inter";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app";
import "./styles.css";

const root = document.getElementById("root");
if (root === null) throw new Error("Firedrill inspector root is unavailable");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
