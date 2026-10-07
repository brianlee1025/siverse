import { createRoot } from "react-dom/client";
import { App } from "./App";
import { connect } from "./store";
import "./styles.css";

connect();

// No <StrictMode>: its double mount makes drei's <Html> overlays (speech bubbles, signs)
// unmount their own React roots mid-render, which floods the console with warnings.
createRoot(document.getElementById("root")!).render(<App />);
