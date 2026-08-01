import { createRoot } from "react-dom/client";
import "../../assets/styles.css";
import { App } from "./App";

// biome-ignore lint/style/noNonNullAssertion: root element guaranteed in index.html
createRoot(document.getElementById("root")!).render(<App />);
