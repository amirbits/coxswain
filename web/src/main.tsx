import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";

// No StrictMode: it double-mounts effects in dev, which would open two
// EventSource connections. Single connection keeps the live loop legible.
createRoot(document.getElementById("root")!).render(<App />);
