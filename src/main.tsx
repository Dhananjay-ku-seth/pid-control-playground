import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";

// StrictMode intentionally double-invokes effects in dev, which would start two rAF
// simulation loops. Omitted here (standard exception for imperative animation apps).
ReactDOM.createRoot(document.getElementById("root")!).render(<App />);
